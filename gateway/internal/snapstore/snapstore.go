// Package snapstore keeps an encrypted copy of the gateway's configuration
// snapshot in Valkey, inside the data plane's failure domain (ADR-0008), so
// a gateway that starts while the control plane is unreachable can still
// serve.
//
// The copy is the same AES-256-GCM blob the gateway writes to disk
// (snapshot.Seal): Valkey never holds plaintext, and nothing here is on the
// request path.
package snapstore

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

// Doer runs one Valkey command. *valkey.Client implements it.
type Doer interface {
	Do(ctx context.Context, args ...string) (any, error)
}

// ErrNotFound means the store has no snapshot for this instance yet.
var ErrNotFound = errors.New("snapstore: no shared snapshot")

// Key returns the Valkey key for an instance's snapshot. The {snapshot}
// hash tag keeps it on one slot of a cluster.
func Key(prefix, instanceID string) string { return prefix + ":{snapshot}:" + instanceID }

// putScript stores the blob unless the store already holds something newer,
// so replicas racing each other never put an older configuration back.
//
// ARGV[4] is the write mode:
//   - "delta": only a higher version replaces the stored one. A delta can
//     miss rows (ADR-0003), so it never overwrites an equal version.
//   - "full": a full resync is the control plane's complete current state,
//     so it also replaces an equal version: a change a delta missed (a row
//     committed out of order, or a control plane older than migration 015,
//     where some changes did not raise the version) arrives that way. It also
//     refreshes the saved-at time, so the copy's age reflects the last
//     confirmation.
//   - "force": always replaces. A gateway that saw the control plane's version
//     go backwards (for example a database restored from a backup) uses it
//     for a copy whose version is now ahead of the truth.
//
// KEYS[1] = <prefix>:{snapshot}:<instance>
// ARGV[1] = version, ARGV[2] = sealed blob, ARGV[3] = saved-at (unix s),
// ARGV[4] = mode. Returns 1 if stored, 0 if skipped.
const putScript = `
local cur = tonumber(redis.call('HGET', KEYS[1], 'v'))
local v = tonumber(ARGV[1])
local mode = ARGV[4]
if cur and mode ~= 'force' then
  if cur > v or (cur == v and mode ~= 'full') then
    return 0
  end
end
redis.call('HSET', KEYS[1], 'v', ARGV[1], 'd', ARGV[2], 'at', ARGV[3])
return 1
`

// Mode says what a write may replace; see putScript.
type Mode string

const (
	ModeDelta Mode = "delta"
	ModeFull  Mode = "full"
	ModeForce Mode = "force"
)

// Store reads and writes one instance's shared snapshot.
type Store struct {
	Client Doer
	Key    string
}

// Entry is a shared snapshot as stored.
type Entry struct {
	Version int64
	Sealed  []byte
	SavedAt time.Time
}

// Put stores sealed as version. It reports whether the store took it
// (false: it already held a newer version, or an equal one for ModeDelta).
func (s *Store) Put(ctx context.Context, version int64, sealed []byte, savedAt time.Time, mode Mode) (bool, error) {
	reply, err := s.Client.Do(ctx, "EVAL", putScript, "1", s.Key,
		strconv.FormatInt(version, 10), string(sealed), strconv.FormatInt(savedAt.Unix(), 10), string(mode))
	if err != nil {
		return false, err
	}
	if e, ok := reply.(error); ok {
		return false, e
	}
	n, ok := reply.(int64)
	if !ok {
		return false, fmt.Errorf("snapstore: unexpected reply %T", reply)
	}
	return n == 1, nil
}

// Get returns the stored snapshot, or ErrNotFound.
func (s *Store) Get(ctx context.Context) (*Entry, error) {
	reply, err := s.Client.Do(ctx, "HMGET", s.Key, "v", "d", "at")
	if err != nil {
		return nil, err
	}
	if e, ok := reply.(error); ok {
		return nil, e
	}
	vals, ok := reply.([]any)
	if !ok || len(vals) != 3 {
		return nil, fmt.Errorf("snapstore: unexpected reply %T", reply)
	}
	if vals[0] == nil || vals[1] == nil {
		return nil, ErrNotFound
	}
	vs, _ := vals[0].(string)
	data, _ := vals[1].(string)
	version, err := strconv.ParseInt(vs, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("snapstore: bad version %q", vs)
	}
	e := &Entry{Version: version, Sealed: []byte(data)}
	if at, ok := vals[2].(string); ok {
		if sec, err := strconv.ParseInt(at, 10, 64); err == nil {
			e.SavedAt = time.Unix(sec, 0)
		}
	}
	return e, nil
}

// Outcome of Bootstrap.
type Outcome int

const (
	// Synced: the primary source stored a configuration before the timeout.
	Synced Outcome = iota
	// Loaded: the shared copy was newer and is now being served.
	Loaded
	// NotNewer: the shared copy was not newer than what was already loaded.
	NotNewer
	// Missing: the store has no copy for this instance.
	Missing
	// Failed: the store could not be read or the copy could not be opened.
	Failed
)

func (o Outcome) String() string {
	return [...]string{"synced", "loaded", "not_newer", "missing", "failed"}[o]
}

// Bootstrap gives the primary source (the control plane) up to timeout to
// store a configuration in holder. If it has not, it loads the shared copy
// when that copy is newer than base, what holder held before the primary
// source started: nothing, or a snapshot restored from disk. The caller
// reads base before starting the primary source, so a sync that lands first
// is never mistaken for the starting point. It never replaces a
// configuration the primary source stored (snapshot.Holder.Replace).
func Bootstrap(ctx context.Context, holder *snapshot.Holder, base *snapshot.State, store *Store, key []byte, timeout, poll time.Duration) (Outcome, *snapshot.State, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	tick := time.NewTicker(poll)
	defer tick.Stop()
wait:
	for {
		select {
		case <-ctx.Done():
			return Failed, nil, ctx.Err()
		case <-deadline.C:
			break wait
		case <-tick.C:
			if holder.State() != base {
				return Synced, nil, nil
			}
		}
	}
	if holder.State() != base {
		return Synced, nil, nil
	}

	rctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	e, err := store.Get(rctx)
	if errors.Is(err, ErrNotFound) {
		return Missing, nil, nil
	}
	if err != nil {
		return Failed, nil, err
	}
	if base != nil && e.Version <= base.Version {
		return NotNewer, nil, nil
	}
	st, err := snapshot.Open(key, e.Sealed)
	if err != nil {
		return Failed, nil, err
	}
	if base != nil && st.Version <= base.Version {
		return NotNewer, nil, nil
	}
	if !holder.Replace(base, st, snapshot.Build(st, e.SavedAt)) {
		return Synced, nil, nil
	}
	return Loaded, st, nil
}
