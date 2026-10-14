package quota

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	mrand "math/rand/v2"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/getstratum/stratum/gateway/internal/metrics"
	"github.com/getstratum/stratum/gateway/internal/policy"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
	"github.com/getstratum/stratum/gateway/internal/valkey"
)

// Doer runs one Valkey command. *valkey.Client implements it.
type Doer interface {
	Do(ctx context.Context, args ...string) (any, error)
}

// flushScript applies one batch of per-team deltas atomically and returns
// the resulting totals, in key order.
//
// It is idempotent per (replica, seq): KEYS[1] stores the last sequence
// number this replica applied, so a batch that is retried after an
// ambiguous failure (the reply was lost, not the write) is not counted
// twice. A delta of 0 is a plain read.
//
// KEYS[1]   = <prefix>:{quota}:seq:<replica>
// KEYS[2..] = <prefix>:{quota}:tok:<month>:<team>
// ARGV[1]   = seq, ARGV[2] = ttl seconds, ARGV[3..] = deltas for KEYS[2..]
//
// All keys share the {quota} hash tag, so the script also works on a
// cluster (they land on one slot).
const flushScript = `
local seq = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local last = tonumber(redis.call('GET', KEYS[1]) or '0')
local apply = seq > last
local out = {}
for i = 2, #KEYS do
  local d = tonumber(ARGV[i + 1])
  if apply and d ~= 0 then
    out[i - 1] = redis.call('INCRBY', KEYS[i], d)
    redis.call('EXPIRE', KEYS[i], ttl)
  else
    out[i - 1] = tonumber(redis.call('GET', KEYS[i]) or '0')
  end
end
if apply then
  redis.call('SET', KEYS[1], seq, 'EX', ttl)
end
return out
`

// keyTTL keeps a month's counters a little longer than the month itself.
const keyTTL = 40 * 24 * time.Hour

// seenTTL is how long a team's total keeps being refreshed after its last
// request on this replica.
const seenTTL = 10 * time.Minute

var unavailable = &policy.Violation{Status: http.StatusServiceUnavailable, Code: "quota_unavailable",
	Message: "the shared quota store is unreachable and this gateway is configured to fail closed"}

// SharedOptions configure a Shared enforcer.
type SharedOptions struct {
	Client     Doer
	Prefix     string        // key prefix; default "stratum"
	Interval   time.Duration // flush/refresh period; default 1s
	StaleAfter time.Duration // after this long without a successful flush the store counts as down; default 30s
	// FailClosed rejects requests of teams with a quota while the store is
	// down. The default (fail open) keeps enforcing against the last known
	// totals plus local consumption.
	FailClosed bool
	MaxKeys    int // teams per flush; default 1000
	Metrics    *metrics.Metrics
	Log        *slog.Logger
}

// Shared enforces quotas against fleet-wide counters kept in Valkey.
//
// Usage for a team = last total read from Valkey + tokens this replica has
// consumed that Valkey has not confirmed yet. Check and Add only touch
// memory. Run flushes local deltas and refreshes totals every Interval.
type Shared struct {
	o       SharedOptions
	replica string
	now     func() time.Time

	mu          sync.Mutex
	month       string
	global      map[string]int64 // team -> last confirmed fleet total, current month
	unconfirmed map[string]int64 // team -> local tokens not yet confirmed, current month
	pending     map[mkey]int64   // deltas not yet in a batch (any month)
	seen        map[string]time.Time
	batch       *batch // sent, not yet acknowledged; retried as-is
	seq         uint64
	lastOK      time.Time
	connected   bool // at least one successful flush
	failing     bool
}

type mkey struct{ month, team string }

type batch struct {
	seq    uint64
	keys   []mkey
	deltas []int64
}

func NewShared(o SharedOptions) *Shared {
	if o.Prefix == "" {
		o.Prefix = "stratum"
	}
	if o.Interval <= 0 {
		o.Interval = time.Second
	}
	if o.StaleAfter <= 0 {
		o.StaleAfter = 30 * time.Second
	}
	if o.MaxKeys <= 0 {
		o.MaxKeys = 1000
	}
	if o.Metrics == nil {
		o.Metrics = metrics.New()
	}
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	o.Metrics.QuotaStoreEnabled.Store(1)
	var id [8]byte
	rand.Read(id[:])
	return &Shared{
		o: o, replica: hex.EncodeToString(id[:]), now: time.Now,
		global: map[string]int64{}, unconfirmed: map[string]int64{},
		pending: map[mkey]int64{}, seen: map[string]time.Time{},
	}
}

func (s *Shared) Check(teamID string, pol snapshot.Policy) *policy.Violation {
	if pol.MonthlyTokenQuota == nil {
		return nil
	}
	s.mu.Lock()
	now := s.now()
	s.rollover(now)
	s.seen[teamID] = now
	used := s.global[teamID] + s.unconfirmed[teamID]
	stale := now.Sub(s.lastOK) > s.o.StaleAfter
	s.mu.Unlock()

	if stale && s.o.FailClosed {
		return unavailable
	}
	if used >= *pol.MonthlyTokenQuota {
		return exceeded
	}
	return nil
}

func (s *Shared) Add(teamID string, tokens int64) {
	if tokens <= 0 {
		return
	}
	s.mu.Lock()
	s.rollover(s.now())
	s.pending[mkey{s.month, teamID}] += tokens
	s.unconfirmed[teamID] += tokens
	s.o.Metrics.QuotaPendingTokens.Add(tokens)
	s.mu.Unlock()
}

// Used returns the team's usage as this replica currently sees it.
func (s *Shared) Used(teamID string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rollover(s.now())
	return s.global[teamID] + s.unconfirmed[teamID]
}

// rollover starts a new month. Pending deltas of the old month are kept and
// still flushed to the old month's key.
func (s *Shared) rollover(now time.Time) {
	m := Month(now)
	if m != s.month {
		s.month = m
		clear(s.global)
		clear(s.unconfirmed)
		clear(s.seen)
	}
}

// Run flushes and refreshes until ctx is cancelled, then makes a last
// attempt to flush what is left (bounded by finalTimeout).
func (s *Shared) Run(ctx context.Context, finalTimeout time.Duration) {
	delay := s.o.Interval
	for {
		select {
		case <-ctx.Done():
			s.drain(finalTimeout)
			return
		case <-time.After(jitter(delay)):
		}
		if err := s.Flush(ctx); err != nil && ctx.Err() == nil {
			delay = min(delay*2, 5*time.Second, max(s.o.Interval, s.o.StaleAfter/4))
		} else {
			delay = s.o.Interval
		}
	}
}

func (s *Shared) drain(timeout time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	for ctx.Err() == nil {
		s.mu.Lock()
		empty := s.batch == nil && len(s.pending) == 0
		s.mu.Unlock()
		if empty {
			return
		}
		if err := s.Flush(ctx); err != nil {
			select {
			case <-ctx.Done():
			case <-time.After(100 * time.Millisecond):
			}
		}
	}
	s.mu.Lock()
	left := int64(0)
	for _, d := range s.pending {
		left += d
	}
	if s.batch != nil {
		for _, d := range s.batch.deltas {
			left += d
		}
	}
	s.mu.Unlock()
	if left > 0 {
		s.o.Log.Warn("shutting down with token usage not written to the shared quota store", "tokens", left)
	}
}

// Flush sends one batch: the deltas accumulated since the last flush plus
// reads for teams recently seen on this replica. A batch that fails is
// retried unchanged on the next call, so it is applied exactly once.
func (s *Shared) Flush(ctx context.Context) error {
	s.mu.Lock()
	now := s.now()
	s.rollover(now)
	if s.batch == nil {
		s.batch = s.nextBatch(now)
	}
	b := s.batch
	s.mu.Unlock()

	var err error
	var totals []int64
	if b == nil {
		_, err = s.o.Client.Do(ctx, "PING")
	} else {
		totals, err = s.send(ctx, b)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		s.o.Metrics.QuotaFlushFailure.Add(1)
		if !s.failing {
			s.failing = true
			s.o.Log.Warn("shared quota store unreachable; enforcing with local counters until it returns", "err", err)
		}
		return err
	}
	switch {
	case s.failing:
		s.failing = false
		s.o.Log.Info("shared quota store reachable again; local usage reconciled")
	case !s.connected:
		s.o.Log.Info("shared quota store connected")
	}
	s.connected = true
	if b != nil {
		for i, k := range b.keys {
			s.o.Metrics.QuotaPendingTokens.Add(-b.deltas[i])
			if k.month != s.month {
				continue
			}
			if prev, ok := s.global[k.team]; ok && totals[i] < prev {
				// Counters only grow within a month. A lower total means the
				// store lost data (restart without persistence) or someone
				// reset the key on purpose. Either way the store wins.
				s.o.Metrics.QuotaStoreRegressions.Add(1)
				s.o.Log.Warn("shared quota counter went backwards; the store lost data or was reset",
					"team_id", k.team, "previous", prev, "now", totals[i])
			}
			s.global[k.team] = totals[i]
			if b.deltas[i] != 0 {
				if u := s.unconfirmed[k.team] - b.deltas[i]; u > 0 {
					s.unconfirmed[k.team] = u
				} else {
					delete(s.unconfirmed, k.team)
				}
			}
		}
		s.batch = nil
	}
	s.lastOK = s.now()
	s.o.Metrics.QuotaFlushSuccess.Add(1)
	s.o.Metrics.QuotaLastSuccess.Store(s.lastOK.Unix())
	return nil
}

// nextBatch takes up to MaxKeys pending deltas, then fills the remaining
// room with reads for recently seen teams. It returns nil when there is
// nothing to send.
func (s *Shared) nextBatch(now time.Time) *batch {
	b := &batch{}
	inBatch := map[mkey]bool{}
	for k, d := range s.pending {
		if len(b.keys) == s.o.MaxKeys {
			break
		}
		b.keys = append(b.keys, k)
		b.deltas = append(b.deltas, d)
		inBatch[k] = true
		delete(s.pending, k)
	}
	for team, t := range s.seen {
		if now.Sub(t) > seenTTL {
			delete(s.seen, team)
			continue
		}
		k := mkey{s.month, team}
		if len(b.keys) == s.o.MaxKeys || inBatch[k] {
			continue
		}
		b.keys = append(b.keys, k)
		b.deltas = append(b.deltas, 0)
	}
	if len(b.keys) == 0 {
		return nil
	}
	s.seq++
	b.seq = s.seq
	return b
}

func (s *Shared) send(ctx context.Context, b *batch) ([]int64, error) {
	args := make([]string, 0, 4+2*len(b.keys)+2)
	args = append(args, "EVAL", flushScript, strconv.Itoa(len(b.keys)+1),
		s.o.Prefix+":{quota}:seq:"+s.replica)
	for _, k := range b.keys {
		args = append(args, s.o.Prefix+":{quota}:tok:"+k.month+":"+k.team)
	}
	args = append(args, strconv.FormatUint(b.seq, 10), strconv.Itoa(int(keyTTL/time.Second)))
	for _, d := range b.deltas {
		args = append(args, strconv.FormatInt(d, 10))
	}

	reply, err := s.o.Client.Do(ctx, args...)
	if err != nil {
		return nil, err
	}
	arr, ok := reply.([]any)
	if !ok || len(arr) != len(b.keys) {
		return nil, fmt.Errorf("%w: unexpected reply to quota flush", valkey.ErrProtocol)
	}
	out := make([]int64, len(arr))
	for i, v := range arr {
		n, err := valkey.Int(v)
		if err != nil {
			return nil, err
		}
		out[i] = n
	}
	return out, nil
}

func jitter(d time.Duration) time.Duration {
	// ±10%, so replicas do not flush in lockstep.
	return d - d/10 + time.Duration(mrand.Int64N(int64(d/5)+1))
}
