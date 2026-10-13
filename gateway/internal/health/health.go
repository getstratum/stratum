// Package health serves liveness and readiness.
//
// Neither probe looks at the control plane, Redis or any other dependency.
// If readiness followed a dependency, an outage of that dependency would
// pull every replica out of the load balancer at once and turn a partial
// failure into a total one.
package health

import (
	"encoding/json"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

type Health struct {
	Holder   *snapshot.Holder
	Version  string
	draining atomic.Bool
}

// SetDraining makes readiness fail so load balancers stop sending traffic,
// while in-flight requests keep being served.
func (h *Health) SetDraining() { h.draining.Store(true) }

// Draining reports whether shutdown has started.
func (h *Health) Draining() bool { return h.draining.Load() }

// Live answers 200 while the process can serve HTTP at all.
func (h *Health) Live(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

// Ready answers 200 when a configuration snapshot is loaded and the gateway
// is not draining. Snapshot age is reported but never fails the probe.
func (h *Health) Ready(w http.ResponseWriter, _ *http.Request) {
	if h.draining.Load() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "draining"})
		return
	}
	snap := h.Holder.Load()
	if snap == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "no_configuration"})
		return
	}
	body := map[string]any{
		"status":           "ready",
		"version":          h.Version,
		"snapshot_version": snap.Version,
		"active_keys":      snap.ActiveKeys(),
	}
	if !snap.SyncedAt.IsZero() {
		body["snapshot_age_seconds"] = int64(snap.Age(time.Now()).Seconds())
	}
	writeJSON(w, http.StatusOK, body)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
