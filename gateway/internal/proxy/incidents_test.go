package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A fake incident service: what it got, and what it answers.
type incidentSink struct {
	got    []map[string]any
	auth   string
	status int
	body   string
}

func (s *incidentSink) server(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/internal/incidents" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		s.auth = r.Header.Get("Authorization")
		var m map[string]any
		json.NewDecoder(r.Body).Decode(&m)
		s.got = append(s.got, m)
		w.WriteHeader(s.status)
		io.WriteString(w, s.body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func report(e *env, key, body string, headers map[string]string) (*http.Response, map[string]any) {
	req, _ := http.NewRequest(http.MethodPost, e.gw.URL+"/v1/stratum/incidents", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+key)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	// Through the gateway's own handler, as the public server routes it.
	rr := httptest.NewRecorder()
	e.h.ReportIncident(rr, req)
	res := rr.Result()
	var m map[string]any
	json.NewDecoder(res.Body).Decode(&m)
	return res, m
}

const what = "El cliente pidió la baja y la herramienta de facturación no respondió: reintenté tres veces."

func TestAgentReportsAnIncident(t *testing.T) {
	sink := &incidentSink{status: http.StatusCreated, body: `{"id":"x","ref":"INC-0042"}`}
	srv := sink.server(t)
	e := newEnv(t, allowAll, time.Minute, func(h *Handler) {
		h.Incidents = &IncidentService{URL: srv.URL + "/", Token: "inc-token"}
		h.RecordClient = true
	})
	res, m := report(e, devKey, `{"what":"`+what+`","task":"ticket-881"}`, map[string]string{"X-Stratum-Agent-Version": "v3"})
	if res.StatusCode != http.StatusCreated || m["ref"] != "INC-0042" {
		t.Fatalf("status %d %v", res.StatusCode, m)
	}
	if sink.auth != "Bearer inc-token" {
		t.Fatalf("auth = %q", sink.auth)
	}
	g := sink.got[0]
	if g["key_id"] != "u1" || g["team_id"] != "t1" || g["what"] != what || g["about"] != "agent" || g["task"] != "ticket-881" || g["agent_version"] != "v3" {
		t.Fatalf("sent = %v", g)
	}
	rec := e.usage.wait(t, 1)[0]
	if rec.Model != "incident" || rec.Reason != "incident_reported" || rec.Task != "ticket-881" || rec.Status != http.StatusCreated {
		t.Fatalf("usage = %+v", rec)
	}

	// The task from the header, as on any request.
	report(e, devKey, `{"what":"`+what+`","about":"other"}`, map[string]string{"X-Stratum-Task": "lote-7"})
	if g := sink.got[1]; g["task"] != "lote-7" || g["about"] != "other" {
		t.Fatalf("sent = %v", g)
	}
}

func TestIncidentReportRefusals(t *testing.T) {
	sink := &incidentSink{status: http.StatusTooManyRequests, body: `{"error":{"code":"too_many_reports","message":"Hasta 10 por hora."}}`}
	srv := sink.server(t)
	e := newEnv(t, allowAll, time.Minute, func(h *Handler) { h.Incidents = &IncidentService{URL: srv.URL, Token: "t"} })
	for _, c := range []struct {
		body, code string
		status     int
	}{
		{`{"what":"corto"}`, "invalid_what", 400},
		{`{"what":"` + what + `","about":"todo"}`, "invalid_about", 400},
		{`{"what":"` + what + `","task":"con espacios"}`, "invalid_task", 400},
		{`no json`, "invalid_json", 400},
		{`{"what":"` + what + `"}`, "too_many_reports", 429}, // the service's own refusal
	} {
		res, m := report(e, devKey, c.body, nil)
		errObj, _ := m["error"].(map[string]any)
		if res.StatusCode != c.status || errObj["code"] != c.code {
			t.Errorf("%s: %d %v", c.body, res.StatusCode, m)
		}
	}
	if res, _ := report(e, "nope", `{"what":"`+what+`"}`, nil); res.StatusCode != 401 {
		t.Errorf("bad key: %d", res.StatusCode)
	}
	if len(sink.got) != 1 {
		t.Errorf("only the valid report reaches the service: %d", len(sink.got))
	}

	// Down: 502, said plainly. Off: 404.
	sink.status = http.StatusInternalServerError
	if res, m := report(e, devKey, `{"what":"`+what+`"}`, nil); res.StatusCode != 502 || m["error"].(map[string]any)["code"] != "incidents_unavailable" {
		t.Errorf("down: %d %v", res.StatusCode, m)
	}
	off := newEnv(t, allowAll, time.Minute)
	if res, m := report(off, devKey, `{"what":"`+what+`"}`, nil); res.StatusCode != 404 || m["error"].(map[string]any)["code"] != "incidents_off" {
		t.Errorf("off: %d %v", res.StatusCode, m)
	}
}
