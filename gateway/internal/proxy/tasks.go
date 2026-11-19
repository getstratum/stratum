package proxy

// Task outcomes (ADR-0019). An application names a task on its requests
// with X-Stratum-Task; when the task ends, it says how: resolved by the
// agent, escalated to a person, or failed. With the requests that named it,
// that is what the console measures an agent by: how many tasks it
// resolves on its own, how many it hands over, what each one costs.

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"time"

	"github.com/getstratum/stratum/gateway/internal/policy"
	"github.com/getstratum/stratum/gateway/internal/usage"
)

// Outcomes a task can end with.
var outcomes = map[string]bool{"resolved": true, "escalated": true, "failed": true}

// outcomeReasonRE: why, as a code the console can count ("no_solution",
// "customer_asked_for_a_person"), never free text: it is stored as usage
// metadata, which holds no content.
var outcomeReasonRE = regexp.MustCompile(`^[a-z0-9_]{1,40}$`)

const maxOutcomeBody = 4 << 10

// agentVersionRE: the version of its instructions an application names
// (X-Stratum-Agent-Version, ADR-0019): "v12", "2026-11-18.1", a commit.
var agentVersionRE = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)

// agentVersion reads X-Stratum-Agent-Version: "" when absent, ok false
// when malformed (the request is refused: a version nobody can group by
// helps nobody).
func agentVersion(r *http.Request) (string, bool) {
	v := r.Header.Get("X-Stratum-Agent-Version")
	if v == "" {
		return "", true
	}
	return v, agentVersionRE.MatchString(v)
}

var badAgentVersion = &policy.Violation{Status: http.StatusBadRequest, Code: "invalid_agent_version",
	Message: "X-Stratum-Agent-Version takes 1 to 64 letters, digits and . _ : -"}

// TaskOutcome is POST /v1/stratum/tasks/{task}: { "outcome": "resolved" |
// "escalated" | "failed", "reason": "<code>" }. It answers 202: the outcome
// travels to the control plane with the usage, off the request path. A
// task may end more than once (reopened, then resolved): the console takes
// the last one.
func (h *Handler) TaskOutcome(w http.ResponseWriter, r *http.Request) {
	rec := &record{start: time.Now()}
	defer h.finishModels(rec)

	snap := h.Holder.Load()
	if snap == nil {
		h.fail(w, rec, &policy.Violation{Status: http.StatusServiceUnavailable, Code: "not_ready", Message: "gateway has no configuration yet"})
		return
	}
	key, teamID, userID, v := h.caller(r, snap)
	if v != nil {
		h.fail(w, rec, v)
		return
	}
	version, ok := agentVersion(r)
	if !ok {
		h.fail(w, rec, badAgentVersion)
		return
	}
	task := r.PathValue("task")
	if !validTask(task) {
		h.fail(w, rec, &policy.Violation{Status: http.StatusBadRequest, Code: "invalid_task",
			Message: "a task takes 1 to 100 letters, digits and . _ : -"})
		return
	}
	var body struct {
		Outcome string `json:"outcome"`
		Reason  string `json:"reason"`
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxOutcomeBody+1))
	if err != nil || len(raw) > maxOutcomeBody || json.Unmarshal(raw, &body) != nil {
		h.fail(w, rec, &policy.Violation{Status: http.StatusBadRequest, Code: "invalid_json",
			Message: `the body is { "outcome": "resolved" | "escalated" | "failed", "reason": "<code>" }`})
		return
	}
	if !outcomes[body.Outcome] {
		h.fail(w, rec, &policy.Violation{Status: http.StatusBadRequest, Code: "invalid_outcome",
			Message: "outcome is resolved, escalated or failed"})
		return
	}
	if body.Reason != "" && !outcomeReasonRE.MatchString(body.Reason) {
		h.fail(w, rec, &policy.Violation{Status: http.StatusBadRequest, Code: "invalid_reason",
			Message: "reason is a code of 1 to 40 lowercase letters, digits and _ (no_solution), not a sentence"})
		return
	}
	recorded := h.Usage != nil
	if recorded {
		h.Usage.Add(usage.Record{
			ID: usage.NewID(), Time: rec.start.UTC(), KeyID: key.ID, UserID: userID, TeamID: teamID,
			Provider: "stratum", Model: "task", Status: http.StatusOK, Reason: "task_outcome",
			Task: task, Outcome: body.Outcome, OutcomeReason: body.Reason, AgentVersion: version,
		})
	}
	attrs := []any{"key_id", key.ID, "team_id", teamID, "task", task, "outcome", body.Outcome}
	if version != "" {
		attrs = append(attrs, "agent_version", version)
	}
	if body.Reason != "" {
		attrs = append(attrs, "reason", body.Reason)
	}
	if userID != "" {
		attrs = append(attrs, "user_id", userID)
	}
	h.Log.Info("task outcome", attrs...)
	rec.status, rec.reason = http.StatusAccepted, "ok"
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]any{"task": task, "outcome": body.Outcome, "recorded": recorded})
}
