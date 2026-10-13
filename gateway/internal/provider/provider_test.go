package provider

import (
	"net/http"
	"testing"

	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

func TestTargetURL(t *testing.T) {
	cases := []struct {
		p     snapshot.Provider
		path  string
		query string
		want  string
	}{
		{snapshot.Provider{Slug: "openai"}, "v1/chat/completions", "", "https://api.openai.com/v1/chat/completions"},
		{snapshot.Provider{Slug: "groq"}, "/v1/chat/completions", "", "https://api.groq.com/openai/v1/chat/completions"},
		{snapshot.Provider{Slug: "gemini"}, "v1/chat/completions", "", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"},
		{snapshot.Provider{Slug: "anthropic"}, "v1/messages", "beta=true", "https://api.anthropic.com/v1/messages?beta=true"},
		{snapshot.Provider{Slug: "azure", BaseURL: "https://r.openai.azure.com/openai/deployments/gpt4o",
			Extra: map[string]any{"api_version": "2024-10-21"}}, "v1/chat/completions", "",
			"https://r.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-10-21"},
	}
	for _, tc := range cases {
		base, ok := BaseURL(tc.p)
		if !ok {
			t.Fatalf("no base url for %s", tc.p.Slug)
		}
		if got := TargetURL(tc.p, base, tc.path, tc.query); got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.p.Slug, got, tc.want)
		}
	}
	if _, ok := BaseURL(snapshot.Provider{Slug: "azure"}); ok {
		t.Error("azure has no default base url")
	}
}

func TestSetAuth(t *testing.T) {
	h := http.Header{}
	SetAuth(h, snapshot.Provider{Slug: "anthropic", APIKey: "k"})
	if h.Get("x-api-key") != "k" || h.Get("anthropic-version") == "" || h.Get("Authorization") != "" {
		t.Fatalf("anthropic headers: %v", h)
	}
	h = http.Header{}
	SetAuth(h, snapshot.Provider{Slug: "groq", APIKey: "g"})
	if h.Get("Authorization") != "Bearer g" {
		t.Fatalf("openai-compatible headers: %v", h)
	}
	h = http.Header{}
	SetAuth(h, snapshot.Provider{Slug: "ollama"})
	if h.Get("Authorization") != "" {
		t.Fatal("no credential means no Authorization header")
	}
}
