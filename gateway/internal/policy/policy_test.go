package policy

import (
	"testing"

	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

func set(v ...string) map[string]struct{} {
	m := map[string]struct{}{}
	for _, s := range v {
		m[s] = struct{}{}
	}
	return m
}

func TestCheck(t *testing.T) {
	base := snapshot.Policy{AllowedModels: set("gpt-4o", "anthropic/claude-sonnet-4")}

	cases := []struct {
		name     string
		pol      snapshot.Policy
		found    bool
		provider string
		model    string
		code     string
	}{
		{"no policy fails closed", base, false, "openai", "gpt-4o", "no_policy"},
		{"revoked team", snapshot.Policy{Revoked: true, AllowAllModels: true}, true, "openai", "gpt-4o", "team_disabled"},
		{"bare model allowed", base, true, "openai", "gpt-4o", ""},
		{"qualified entry matches", base, true, "anthropic", "claude-sonnet-4", ""},
		{"model not allowed", base, true, "openai", "gpt-4.1", "model_not_allowed"},
		{"empty allowlist denies", snapshot.Policy{}, true, "openai", "gpt-4o", "model_not_allowed"},
		{"allow all", snapshot.Policy{AllowAllModels: true}, true, "groq", "anything", ""},
		{"provider restriction", snapshot.Policy{AllowAllModels: true, AllowedProviders: set("openai")}, true, "groq", "x", "provider_not_allowed"},
		{"missing model", snapshot.Policy{AllowAllModels: true}, true, "openai", "", "missing_model"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := Check(tc.pol, tc.found, tc.provider, tc.model)
			got := ""
			if v != nil {
				got = v.Code
			}
			if got != tc.code {
				t.Fatalf("got %q, want %q", got, tc.code)
			}
		})
	}
}
