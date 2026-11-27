package proxy

// An agent reports a problem (ADR-0021). It already holds a key and talks
// to the gateway; the gateway knows which agent, team and person the key
// is, so it passes the report on to the incident service (Stratum
// Enterprise → Incidentes) with that identity, under a token of its own.
// The agent never holds a second secret nor needs to reach the service.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/getstratum/stratum/gateway/internal/policy"
	"github.com/getstratum/stratum/gateway/internal/usage"
)

// IncidentService is where reports go: Stratum Enterprise, at
// {URL}/api/internal/incidents, with Token as bearer. Nil: no incident
// service, the endpoint answers 404.
type IncidentService struct {
	URL    string
	Token  string
	Client *http.Client
}

const (
	minIncidentText = 20
	maxIncidentText = 4000
	maxIncidentBody = 16 << 10
)

// What a report is about, as Incidentes files it.
var incidentAbout = map[string]bool{"agent": true, "chat": true, "other": true}

var incidentsOff = &policy.Violation{Status: http.StatusNotFound, Code: "incidents_off",
	Message: "this installation has no incident service: ask whoever runs Stratum (Stratum Enterprise, Incidentes)"}

// ReportIncident is POST /v1/stratum/incidents: { "what": "<what happened,
// 20 to 4000 characters>", "about": "agent" | "chat" | "other", "task":
// "<task>" }. It answers 201 with the incident's reference (INC-0042), or
// the service's refusal (429 when the agent reports too often).
func (h *Handler) ReportIncident(w http.ResponseWriter, r *http.Request) {
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
	if h.Incidents == nil || h.Incidents.URL == "" {
		h.fail(w, rec, incidentsOff)
		return
	}
	version, ok := agentVersion(r)
	if !ok {
		h.fail(w, rec, badAgentVersion)
		return
	}
	var body struct {
		What  string `json:"what"`
		About string `json:"about"`
		Task  string `json:"task"`
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxIncidentBody+1))
	if err != nil || len(raw) > maxIncidentBody || json.Unmarshal(raw, &body) != nil {
		h.fail(w, rec, &policy.Violation{Status: http.StatusBadRequest, Code: "invalid_json",
			Message: `the body is { "what": "<what happened>", "about": "agent" | "chat" | "other", "task": "<task>" }`})
		return
	}
	body.What = strings.TrimSpace(body.What)
	if n := utf8.RuneCountInString(body.What); n < minIncidentText || n > maxIncidentText || !utf8.ValidString(body.What) {
		h.fail(w, rec, &policy.Violation{Status: http.StatusBadRequest, Code: "invalid_what",
			Message: "what: what happened, in 20 to 4000 characters"})
		return
	}
	if body.About == "" {
		body.About = "agent"
	}
	if !incidentAbout[body.About] {
		h.fail(w, rec, &policy.Violation{Status: http.StatusBadRequest, Code: "invalid_about", Message: "about is agent, chat or other"})
		return
	}
	if body.Task == "" {
		body.Task = r.Header.Get("X-Stratum-Task")
	}
	if body.Task != "" && !validTask(body.Task) {
		h.fail(w, rec, &policy.Violation{Status: http.StatusBadRequest, Code: "invalid_task",
			Message: "a task takes 1 to 100 letters, digits and . _ : -"})
		return
	}
	var requestID string
	if h.RequestID != nil {
		requestID = h.RequestID(r.Context())
	}
	ip, ua := h.origin(r)
	report := map[string]any{
		"key_id": key.ID, "team_id": teamID, "user_id": userID, "task": body.Task, "about": body.About,
		"what": body.What, "agent_version": version, "request_id": requestID, "client_ip": ip, "user_agent": ua,
	}
	status, answer := h.Incidents.send(r.Context(), report)
	switch {
	case status == http.StatusCreated:
	case status == http.StatusTooManyRequests || status == http.StatusBadRequest || status == http.StatusForbidden:
		// The service's own refusal, as it said it.
		h.fail(w, rec, &policy.Violation{Status: status, Code: answer.code("refused"), Message: answer.message("the incident service refused the report")})
		return
	default:
		h.Log.Warn("incident service failed", "status", status, "key_id", key.ID)
		h.fail(w, rec, &policy.Violation{Status: http.StatusBadGateway, Code: "incidents_unavailable",
			Message: "the incident service did not take the report: try again in a while"})
		return
	}
	// The report, never its text, in Requests: who reported and when.
	if h.Usage != nil {
		h.Usage.Add(usage.Record{
			ID: usage.NewID(), Time: rec.start.UTC(), RequestID: usage.Clip(requestID, 128), KeyID: key.ID, UserID: userID, TeamID: teamID,
			Provider: "stratum", Model: "incident", Status: http.StatusCreated, Reason: "incident_reported",
			Task: body.Task, AgentVersion: version, ClientIP: ip, UserAgent: ua,
		})
	}
	h.Log.Info("incident reported", "key_id", key.ID, "team_id", teamID, "ref", answer.Ref)
	rec.status, rec.reason = http.StatusCreated, "ok"
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"ref": answer.Ref})
}

type serviceAnswer struct {
	Ref   string `json:"ref"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (a serviceAnswer) code(def string) string {
	if a.Error != nil && a.Error.Code != "" {
		return usage.Clip(a.Error.Code, 64)
	}
	return def
}

func (a serviceAnswer) message(def string) string {
	if a.Error != nil && a.Error.Message != "" {
		return usage.Clip(a.Error.Message, 300)
	}
	return def
}

// send posts the report; status 0 when the service could not be reached.
func (s *IncidentService) send(ctx context.Context, report map[string]any) (int, serviceAnswer) {
	var answer serviceAnswer
	b, _ := json.Marshal(report)
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.URL, "/")+"/api/internal/incidents", bytes.NewReader(b))
	if err != nil {
		return 0, answer
	}
	req.Header.Set("Content-Type", "application/json")
	if s.Token != "" {
		req.Header.Set("Authorization", "Bearer "+s.Token)
	}
	client := s.Client
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return 0, answer
	}
	defer res.Body.Close()
	json.NewDecoder(io.LimitReader(res.Body, 16<<10)).Decode(&answer)
	return res.StatusCode, answer
}
