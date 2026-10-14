// Package syncer feeds the snapshot holder from a configuration source: the
// Stratum control plane (pull, delta + periodic full resync) or a local file.
//
// The request path never waits on a syncer. If the source is down the
// gateway keeps serving the last good snapshot for as long as it takes.
package syncer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/getstratum/stratum/gateway/internal/metrics"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

// maxSyncBody bounds what we read from the control plane.
const maxSyncBody = 64 << 20

// ControlPlane pulls configuration from GET {URL}/api/internal/sync.
//
// Deltas use since_version. Because PostgreSQL sequence values can commit
// out of order, a delta can skip a row for good; the periodic full resync
// (FullEvery) is what makes the gateway converge anyway. Full resyncs pass
// through snapshot.Guard before they replace anything.
type ControlPlane struct {
	URL        string
	Token      string
	InstanceID string
	UserAgent  string

	Interval  time.Duration
	FullEvery time.Duration

	MaxDropRatio float64
	GuardMinKeys int

	Holder *snapshot.Holder
	// Persist is optional; it is called after a change is applied, with the
	// state it replaced (nil on the first sync) and whether next came from a
	// full resync, i.e. is the control plane's complete current state.
	Persist func(prev, next *snapshot.State, full bool)
	Client  *http.Client
	Log     *slog.Logger
	Metrics *metrics.Metrics

	now      func() time.Time
	lastFull time.Time
}

func (c *ControlPlane) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

// Run syncs until ctx is cancelled.
func (c *ControlPlane) Run(ctx context.Context) {
	failures := 0
	forceFull := false
	for {
		wait, needFull, err := c.SyncOnce(ctx, forceFull)
		forceFull = needFull
		switch {
		case err == nil:
			failures = 0
		case errors.Is(err, snapshot.ErrSuspiciousChange):
			// Keep serving the previous snapshot; try again at the next full resync.
			c.Log.Error("full resync rejected, still serving previous snapshot", "err", err)
		case ctx.Err() != nil:
			return
		default:
			failures++
			wait = backoff(failures)
			c.Log.Warn("sync with control plane failed; serving last known good snapshot",
				"err", err, "consecutive_failures", failures, "retry_in", wait.Round(time.Millisecond))
		}
		if needFull && err == nil {
			wait = 0
		}
		if !sleep(ctx, jitter(wait)) {
			return
		}
	}
}

// SyncOnce performs one sync round. It returns how long to wait before the
// next round and whether the next round must be a full resync.
func (c *ControlPlane) SyncOnce(ctx context.Context, forceFull bool) (time.Duration, bool, error) {
	prev := c.Holder.State()
	now := c.clock()
	full := forceFull || prev == nil || now.Sub(c.lastFull) >= c.FullEvery

	var since int64
	if !full {
		since = prev.Version
	}
	resp, err := c.fetch(ctx, since)
	if err != nil {
		c.Metrics.SyncFailure.Add(1)
		return 0, forceFull, err
	}

	if !full && int64(resp.CurrentVersion) < prev.Version {
		// The control plane's version went backwards: most likely its database
		// was restored from a backup. Re-read everything, through the guard.
		c.Log.Warn("control plane version went backwards; forcing a full resync",
			"local_version", prev.Version, "remote_version", int64(resp.CurrentVersion))
		return 0, true, nil
	}

	next, err := prev.Apply(resp, full)
	if err != nil {
		c.Metrics.SyncFailure.Add(1)
		return 0, false, err
	}
	if full {
		c.lastFull = now
		if err := snapshot.Guard(prev, next, c.MaxDropRatio, c.GuardMinKeys); err != nil {
			c.Metrics.GuardRejected.Add(1)
			return c.interval(resp), false, err
		}
	}

	c.Holder.Store(next, snapshot.Build(next, now))
	c.Metrics.SyncSuccess.Add(1)
	c.Metrics.SnapshotVersion.Store(next.Version)
	c.Metrics.SnapshotSynced.Store(now.Unix())

	changed := full || prev == nil || len(resp.Policies)+len(resp.APIKeys)+len(resp.ProviderConfigs) > 0
	if changed && c.Persist != nil {
		c.Persist(prev, next, full)
	}
	if changed {
		c.Log.Info("configuration applied", "version", next.Version, "full", full,
			"policies", len(resp.Policies), "api_keys", len(resp.APIKeys), "providers", len(resp.ProviderConfigs))
	}
	return c.interval(resp), false, nil
}

func (c *ControlPlane) interval(resp *snapshot.SyncResponse) time.Duration {
	if n := time.Duration(resp.NextSyncInSeconds) * time.Second; n > 0 {
		return min(max(n, 5*time.Second), 5*time.Minute)
	}
	return c.Interval
}

func (c *ControlPlane) fetch(ctx context.Context, since int64) (*snapshot.SyncResponse, error) {
	q := url.Values{}
	q.Set("since_version", strconv.FormatInt(since, 10))
	q.Set("instance_id", c.InstanceID)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL+"/api/internal/sync?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Accept", "application/json")
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}

	res, err := c.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		snippet, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return nil, fmt.Errorf("control plane answered %d: %s", res.StatusCode, snippet)
	}
	var out snapshot.SyncResponse
	if err := json.NewDecoder(io.LimitReader(res.Body, maxSyncBody)).Decode(&out); err != nil {
		return nil, fmt.Errorf("decoding sync response: %w", err)
	}
	return &out, nil
}

// backoff grows exponentially from 1s and caps at 2 minutes.
func backoff(failures int) time.Duration {
	d := time.Second << min(failures-1, 7)
	return min(d, 2*time.Minute)
}

// jitter spreads gateways out (±20%) so a fleet does not sync in lockstep.
func jitter(d time.Duration) time.Duration {
	if d <= 0 {
		return 0
	}
	return time.Duration(float64(d) * (0.8 + 0.4*rand.Float64()))
}

func sleep(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
