package main

import (
	"encoding/json"
	"testing"
)

func TestTokens(t *testing.T) {
	var req request
	if err := json.Unmarshal([]byte(`{"model":"m","max_tokens":700,
		"messages":[{"role":"user","content":"0123456789012345678901234567890123456789"}]}`), &req); err != nil {
		t.Fatal(err)
	}
	if p, c := (config{}).tokens(req); p != 60 || c != 40 {
		t.Fatalf("fixed: got %d/%d, want 60/40", p, c)
	}
	p, c := config{usageFromReq: true}.tokens(req)
	if c != 700 {
		t.Fatalf("completion: got %d, want max_tokens 700", c)
	}
	if want := len(req.Messages[0])/4 + 1; p != want {
		t.Fatalf("prompt: got %d, want %d", p, want)
	}
	req.MaxTokens, req.MaxCompletionTokens = 0, 300
	if _, c := (config{usageFromReq: true}).tokens(req); c != 300 {
		t.Fatalf("max_completion_tokens: got %d", c)
	}
	req.MaxCompletionTokens = 0
	if _, c := (config{usageFromReq: true}).tokens(req); c != 40 {
		t.Fatalf("no max: got %d", c)
	}
	req.MaxTokens = 8192
	if _, c := (config{usageFromReq: true, maxCompletion: 600}).tokens(req); c != 600 {
		t.Fatalf("MOCK_MAX_COMPLETION_TOKENS: got %d, want 600", c)
	}
	req.MaxTokens = 200
	if _, c := (config{usageFromReq: true, maxCompletion: 600}).tokens(req); c != 200 {
		t.Fatalf("under the limit: got %d, want 200", c)
	}
}
