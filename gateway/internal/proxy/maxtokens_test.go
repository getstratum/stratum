package proxy

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/provider"
	"github.com/getstratum/stratum/gateway/internal/quota"
)

func TestCapOutputTokens(t *testing.T) {
	num := func(v any) int64 { n, _ := asInt(v); return n }
	cases := []struct {
		name, path, slug string
		kind             provider.Kind
		body             string
		want             map[string]int64 // fields after capping; absent = must not be set
		changed          bool
	}{
		{"chat above the limit", "v1/chat/completions", "groq", provider.KindOpenAI, `{"max_tokens":9000}`, map[string]int64{"max_tokens": 4000}, true},
		{"chat under the limit", "v1/chat/completions", "groq", provider.KindOpenAI, `{"max_tokens":100}`, map[string]int64{"max_tokens": 100}, false},
		{"chat both fields", "v1/chat/completions", "openai", provider.KindOpenAI, `{"max_tokens":100,"max_completion_tokens":5000}`, map[string]int64{"max_tokens": 100, "max_completion_tokens": 4000}, true},
		{"chat none, OpenAI", "v1/chat/completions", "openai", provider.KindOpenAI, `{}`, map[string]int64{"max_completion_tokens": 4000}, true},
		{"chat none, other provider", "v1/chat/completions", "ollama", provider.KindOpenAI, `{}`, map[string]int64{"max_tokens": 4000}, true},
		{"chat none, Azure", "openai/deployments/x/chat/completions", "azure", provider.KindAzure, `{}`, map[string]int64{"max_completion_tokens": 4000}, true},
		{"not a number", "v1/chat/completions", "groq", provider.KindOpenAI, `{"max_tokens":"lots"}`, map[string]int64{"max_tokens": 4000}, true},
		{"anthropic", "v1/messages", "anthropic", provider.KindAnthropic, `{"max_tokens":64000}`, map[string]int64{"max_tokens": 4000}, true},
		{"responses", "v1/responses", "openai", provider.KindOpenAI, `{"input":"hi"}`, map[string]int64{"max_output_tokens": 4000}, true},
		{"legacy completions", "v1/completions", "openai", provider.KindOpenAI, `{"max_tokens":4001}`, map[string]int64{"max_tokens": 4000}, true},
		{"embeddings untouched", "v1/embeddings", "openai", provider.KindOpenAI, `{"input":"hi"}`, map[string]int64{}, false},
		{"anthropic count_tokens untouched", "v1/messages/count_tokens", "anthropic", provider.KindAnthropic, `{}`, map[string]int64{}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			body, err := decodeObject([]byte(c.body))
			if err != nil {
				t.Fatal(err)
			}
			if got := capOutputTokens(body, c.path, c.slug, c.kind, 4000); got != c.changed {
				t.Fatalf("changed = %v", got)
			}
			for f, want := range c.want {
				if got := num(body[f]); got != want {
					t.Errorf("%s = %v, want %d", f, body[f], want)
				}
			}
			for _, f := range []string{"max_tokens", "max_completion_tokens", "max_output_tokens"} {
				_, wanted := c.want[f]
				if _, set := body[f]; set && !wanted && !jsonHas(c.body, f) {
					t.Errorf("%s must not be added: %v", f, body)
				}
			}
		})
	}
}

func jsonHas(raw, field string) bool {
	var m map[string]any
	json.Unmarshal([]byte(raw), &m)
	_, ok := m[field]
	return ok
}

func TestMaxTokensPerRequestReachesTheProvider(t *testing.T) {
	e := newEnv(t, `{"id":"p","team_id":"t1","version":1,"allow_all_models":true,"max_tokens_per_request":256}`, time.Minute)
	res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o","max_completion_tokens":10000,"messages":[]}`)
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if got := res.Header.Get("X-Stratum-Max-Tokens"); got != "256" {
		t.Errorf("X-Stratum-Max-Tokens = %q", got)
	}
	e.up.mu.Lock()
	sent := e.up.body["max_completion_tokens"]
	e.up.mu.Unlock()
	if sent != float64(256) {
		t.Fatalf("provider got max_completion_tokens = %v", sent)
	}

	// Under the limit: forwarded as asked, no header.
	res = e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o","max_completion_tokens":100,"messages":[]}`)
	if res.Header.Get("X-Stratum-Max-Tokens") != "" {
		t.Error("nothing was capped")
	}
	e.up.mu.Lock()
	sent = e.up.body["max_completion_tokens"]
	e.up.mu.Unlock()
	if sent != float64(100) {
		t.Fatalf("provider got %v", sent)
	}
}

func TestBudgetRefusesWithReportedSpend(t *testing.T) {
	e := newEnv(t, `{"id":"p","team_id":"t1","version":1,"allow_all_models":true,"monthly_budget_usd":"25.00"}`, time.Minute)
	if res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o","messages":[]}`); res.StatusCode != 200 {
		t.Fatalf("no report yet: %d", res.StatusCode)
	}
	e.quota.SetReported(quota.Month(time.Now()), map[string]quota.Reported{"t1": {CostUSD: 25.5}})
	res := e.post("/v1/chat/completions", devKey, `{"model":"openai/gpt-4o","messages":[]}`)
	if res.StatusCode != 429 || errCode(t, res) != "budget_exceeded" {
		t.Fatalf("over budget: %d", res.StatusCode)
	}
}
