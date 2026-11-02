package proxy

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/decision"
)

// decider is a fake set of decision services.
type decider struct {
	mu      sync.Mutex
	answer  decision.Decision
	checks  []decision.Request
	reports []decision.Report
}

func (d *decider) Check(_ context.Context, r decision.Request) decision.Decision {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.checks = append(d.checks, r)
	return d.answer
}

func (d *decider) Report(r decision.Report) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.reports = append(d.reports, r)
}

func (d *decider) waitReports(t *testing.T, n int) []decision.Report {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		d.mu.Lock()
		got := append([]decision.Report(nil), d.reports...)
		d.mu.Unlock()
		if len(got) >= n || time.Now().After(deadline) {
			return got
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (e *env) postWith(path, key, body string, headers map[string]string) *http.Response {
	e.t.Helper()
	req, _ := http.NewRequest(http.MethodPost, e.gw.URL+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+key)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { res.Body.Close() })
	return res
}

const chat = `{"model":"openai/gpt-4o","messages":[{"role":"user","content":"hola"}]}`

func TestDecisionServicesSeeMetadataAndAHashNeverTheText(t *testing.T) {
	d := &decider{answer: decision.Decision{Allow: true, Labels: []string{"loop_watch"}, Headers: map[string]string{"X-Stratum-Task-Budget": "0.4"}}}
	e := newEnv(t, allowAll, time.Minute, func(h *Handler) { h.Decision = d })

	res := e.postWith("/v1/chat/completions", agentKey, chat, map[string]string{"X-Stratum-Task": "ticket-42", "X-Stratum-Labels": "support"})
	if res.StatusCode != 200 || res.Header.Get("X-Stratum-Task-Budget") != "0.4" {
		t.Fatalf("status %d, header %q", res.StatusCode, res.Header.Get("X-Stratum-Task-Budget"))
	}
	if len(d.checks) != 1 {
		t.Fatalf("%d checks", len(d.checks))
	}
	c := d.checks[0]
	if c.KeyID != "agent:a1" || c.TeamID != "t1" || c.Task != "ticket-42" || c.Provider != "openai" || c.Model != "gpt-4o-mini" ||
		c.Operation != "chat" || len(c.ContentSHA256) != 64 || c.ContentBytes == 0 || len(c.Labels) != 1 {
		t.Errorf("check = %+v", c)
	}
	// The same content, with other settings, has the same hash; other content does not.
	e.postWith("/v1/chat/completions", agentKey, `{"temperature":0.2,"messages":[{"content":"hola","role":"user"}],"model":"openai/gpt-4o"}`, nil)
	e.postWith("/v1/chat/completions", agentKey, `{"model":"openai/gpt-4o","messages":[{"role":"user","content":"chau"}]}`, nil)
	if d.checks[1].ContentSHA256 != c.ContentSHA256 || d.checks[2].ContentSHA256 == c.ContentSHA256 {
		t.Error("the content hash depends on what was asked, not on how")
	}

	// The labels the services add reach the usage record.
	rec := e.usage.wait(t, 1)[0]
	if strings.Join(rec.Labels, ",") != "loop_watch,support" {
		t.Errorf("usage labels = %v", rec.Labels)
	}
	// Each checked request is reported as it ended.
	rep := d.waitReports(t, 3)
	if len(rep) != 3 || rep[0].Status != 200 || rep[0].TokensIn != 11 || rep[0].Task != "ticket-42" || rep[0].ContentSHA256 != c.ContentSHA256 {
		t.Errorf("reports = %+v", rep)
	}
}

func TestADecisionServiceDenies(t *testing.T) {
	d := &decider{answer: decision.Decision{Status: 429, Code: "agent_loop", Message: "el agente repite el mismo pedido",
		Headers: map[string]string{"Retry-After": "30"}}}
	e := newEnv(t, allowAll, time.Minute, func(h *Handler) { h.Decision = d })
	res := e.postWith("/v1/chat/completions", agentKey, chat, nil)
	if res.StatusCode != 429 || res.Header.Get("Retry-After") != "30" || errCode(t, res) != "agent_loop" {
		t.Fatalf("status %d", res.StatusCode)
	}
	if e.up.path != "" {
		t.Error("a denied request reached the provider")
	}
	if rec := e.usage.wait(t, 1)[0]; rec.Status != 429 || rec.Reason != "agent_loop" {
		t.Errorf("usage = %+v", rec)
	}
	if rep := d.waitReports(t, 1); len(rep) != 1 || rep[0].Reason != "agent_loop" {
		t.Errorf("reports = %+v", rep)
	}
}

func TestDecisionServicesAreAskedOnlyForWhatPassedTheGateway(t *testing.T) {
	d := &decider{answer: decision.Decision{Allow: true, Skipped: true}}
	e := newEnv(t, `{"id":"p","team_id":"t1","version":1,"allowed_models":["openai/gpt-4o"],"pii_action":"redact","dlp_action":"block"}`,
		time.Minute, func(h *Handler) { h.Decision = d })
	if res := e.postWith("/v1/chat/completions", devKey, `{"model":"openai/o3","messages":[]}`, nil); res.StatusCode != 403 {
		t.Fatalf("policy: %d", res.StatusCode)
	}
	if res := e.postWith("/v1/chat/completions", devKey, chat, map[string]string{"X-Stratum-Task": "no spaces please"}); res.StatusCode != 400 || errCode(t, res) != "invalid_task" {
		t.Fatalf("task: %d", res.StatusCode)
	}
	if len(d.checks) != 0 {
		t.Errorf("%d checks for refused requests", len(d.checks))
	}
	// A service that did not answer (fail open) is marked on the request.
	if res := e.postWith("/v1/chat/completions", devKey, chat, nil); res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	recs := e.usage.wait(t, 3)
	if last := recs[len(recs)-1]; strings.Join(last.Labels, ",") != "decision_skipped" {
		t.Errorf("labels = %v", last.Labels)
	}
}

func TestWithoutDecisionServicesTheTaskHeaderIsIgnored(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	if res := e.postWith("/v1/chat/completions", devKey, chat, map[string]string{"X-Stratum-Task": "no spaces please"}); res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestMergeLabels(t *testing.T) {
	got := mergeLabels([]string{"b", "a"}, []string{"a", "c", "BAD"})
	if strings.Join(got, ",") != "a,b,c" {
		t.Errorf("got %v", got)
	}
	full := []string{"l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"}
	if got := mergeLabels(full, []string{"x"}); len(got) != 8 || strings.Contains(strings.Join(got, ","), "x") {
		t.Errorf("past 8: %v", got)
	}
}
