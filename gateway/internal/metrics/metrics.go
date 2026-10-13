// Package metrics exposes gateway counters in the Prometheus text format.
// It is deliberately tiny and dependency-free; OpenTelemetry export is a
// separate, later concern.
package metrics

import (
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Metrics struct {
	mu       sync.Mutex
	requests map[reqKey]*atomic.Int64

	Inflight        atomic.Int64
	Overloaded      atomic.Int64 // requests shed by the concurrency limiter
	SyncSuccess     atomic.Int64
	SyncFailure     atomic.Int64
	GuardRejected   atomic.Int64 // full resyncs rejected by snapshot.Guard
	SnapshotVersion atomic.Int64
	SnapshotSynced  atomic.Int64 // unix seconds of last confirmation from the source
	PersistFailure  atomic.Int64
	UpstreamTokens  atomic.Int64
}

type reqKey struct {
	code     int
	provider string
	reason   string
}

func New() *Metrics { return &Metrics{requests: map[reqKey]*atomic.Int64{}} }

// Request counts one finished request. reason is a short, bounded code
// ("ok", "unauthorized", "policy", "upstream_error", ...), never free text.
func (m *Metrics) Request(code int, provider, reason string) {
	k := reqKey{code: code, provider: provider, reason: reason}
	m.mu.Lock()
	c, ok := m.requests[k]
	if !ok {
		c = &atomic.Int64{}
		m.requests[k] = c
	}
	m.mu.Unlock()
	c.Add(1)
}

// WriteTo renders all metrics in Prometheus exposition format.
func (m *Metrics) WriteTo(w io.Writer, now time.Time) {
	var b strings.Builder

	b.WriteString("# HELP stratum_requests_total Requests handled by the gateway.\n")
	b.WriteString("# TYPE stratum_requests_total counter\n")
	m.mu.Lock()
	keys := make([]reqKey, 0, len(m.requests))
	for k := range m.requests {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, c reqKey) int {
		if a.provider != c.provider {
			return strings.Compare(a.provider, c.provider)
		}
		if a.code != c.code {
			return a.code - c.code
		}
		return strings.Compare(a.reason, c.reason)
	})
	for _, k := range keys {
		fmt.Fprintf(&b, "stratum_requests_total{code=\"%d\",provider=%q,reason=%q} %d\n",
			k.code, k.provider, k.reason, m.requests[k].Load())
	}
	m.mu.Unlock()

	gauge(&b, "stratum_inflight_requests", "Requests currently being served.", m.Inflight.Load())
	counter(&b, "stratum_overload_rejections_total", "Requests rejected by the concurrency limiter.", m.Overloaded.Load())
	counter(&b, "stratum_sync_success_total", "Successful syncs with the configuration source.", m.SyncSuccess.Load())
	counter(&b, "stratum_sync_failure_total", "Failed syncs with the configuration source.", m.SyncFailure.Load())
	counter(&b, "stratum_snapshot_guard_rejections_total", "Full resyncs rejected as suspicious.", m.GuardRejected.Load())
	counter(&b, "stratum_snapshot_persist_failures_total", "Failed writes of the snapshot to disk.", m.PersistFailure.Load())
	counter(&b, "stratum_upstream_tokens_total", "Tokens reported by upstream providers.", m.UpstreamTokens.Load())
	gauge(&b, "stratum_snapshot_version", "Configuration version currently served.", m.SnapshotVersion.Load())

	age := int64(-1)
	if s := m.SnapshotSynced.Load(); s > 0 {
		age = now.Unix() - s
	}
	gauge(&b, "stratum_snapshot_age_seconds", "Seconds since the source last confirmed the configuration (-1 = never).", age)

	io.WriteString(w, b.String())
}

func counter(b *strings.Builder, name, help string, v int64) { metric(b, name, help, "counter", v) }
func gauge(b *strings.Builder, name, help string, v int64)   { metric(b, name, help, "gauge", v) }

func metric(b *strings.Builder, name, help, typ string, v int64) {
	fmt.Fprintf(b, "# HELP %s %s\n# TYPE %s %s\n%s %d\n", name, help, name, typ, name, v)
}
