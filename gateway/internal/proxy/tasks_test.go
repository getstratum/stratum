package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/usage"
)

// A task's requests carry it, and its end is a record of its own
// (ADR-0019).
func TestTaskOnRecordsAndOutcome(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/stratum/tasks/{task}", e.h.TaskOutcome)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	end := func(key, task, body string) (int, map[string]any) {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/stratum/tasks/"+task, strings.NewReader(body))
		if key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}

	// Without decision services the header is still kept on the record.
	chat := `{"model":"openai/gpt-4o","messages":[{"role":"user","content":"hola"}]}`
	if res := e.postWith("/v1/chat/completions", agentKey, chat, map[string]string{"X-Stratum-Task": "ticket-42"}); res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	code, out := end(agentKey, "ticket-42", `{"outcome":"escalated","reason":"customer_asked_for_a_person"}`)
	if code != 202 || out["outcome"] != "escalated" || out["recorded"] != true {
		t.Fatalf("outcome: %d %v", code, out)
	}
	got := e.usage.wait(t, 2)
	if got[0].Task != "ticket-42" || got[0].Outcome != "" {
		t.Errorf("request record: %+v", got[0])
	}
	o := got[1]
	if o.KeyID != "agent:a1" || o.TeamID != "t1" || o.Task != "ticket-42" || o.Outcome != "escalated" ||
		o.OutcomeReason != "customer_asked_for_a_person" || o.Provider != "stratum" || o.Model != "task" ||
		o.Status != 200 || o.Reason != "task_outcome" || o.TokensIn != 0 || o.ID == "" {
		t.Errorf("outcome record: %+v", o)
	}

	for _, c := range []struct{ key, task, body, code string }{
		{"", "ticket-42", `{"outcome":"resolved"}`, "missing_api_key"},
		{agentKey, "no%20spaces", `{"outcome":"resolved"}`, "invalid_task"},
		{agentKey, "ticket-42", `{"outcome":"done"}`, "invalid_outcome"},
		{agentKey, "ticket-42", `{"outcome":"failed","reason":"Se cayó el CRM"}`, "invalid_reason"},
		{agentKey, "ticket-42", `not json`, "invalid_json"},
		{agentKey, "ticket-42", `{"outcome":"resolved","pad":"` + strings.Repeat("x", 5000) + `"}`, "invalid_json"},
	} {
		code, out := end(c.key, c.task, c.body)
		got, _ := out["error"].(map[string]any)
		if code < 400 || got["code"] != c.code {
			t.Errorf("%s %s: %d %v", c.task, c.body[:min(len(c.body), 40)], code, out)
		}
	}
	if n := len(e.usage.wait(t, 2)); n != 2 {
		t.Errorf("%d records: refused outcomes are not recorded", n)
	}

	// CI checks what the gateway really sends against api/usage/v1.
	if dir := os.Getenv("USAGE_EXAMPLES_DIR"); dir != "" {
		b, err := json.MarshalIndent(usage.Batch{InstanceID: "dp_test", Records: got}, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "task-records.json"), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// The version of its instructions an application names goes on its
// requests and its tasks' ends; a malformed one is refused.
func TestAgentVersion(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/stratum/tasks/{task}", e.h.TaskOutcome)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	chat := `{"model":"openai/gpt-4o","messages":[{"role":"user","content":"hola"}]}`
	h := map[string]string{"X-Stratum-Task": "t-1", "X-Stratum-Agent-Version": "v12"}
	if res := e.postWith("/v1/chat/completions", agentKey, chat, h); res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/stratum/tasks/t-1", strings.NewReader(`{"outcome":"resolved"}`))
	req.Header.Set("Authorization", "Bearer "+agentKey)
	req.Header.Set("X-Stratum-Agent-Version", "v12")
	res, err := http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 202 {
		t.Fatalf("outcome: %v %v", res, err)
	}
	got := e.usage.wait(t, 2)
	if got[0].AgentVersion != "v12" || got[1].AgentVersion != "v12" || got[1].Outcome != "resolved" {
		t.Errorf("records: %+v %+v", got[0], got[1])
	}
	bad := e.postWith("/v1/chat/completions", agentKey, chat, map[string]string{"X-Stratum-Agent-Version": "v 12 nueva"})
	if bad.StatusCode != 400 || errCode(t, bad) != "invalid_agent_version" {
		t.Errorf("malformed: %d", bad.StatusCode)
	}
}

