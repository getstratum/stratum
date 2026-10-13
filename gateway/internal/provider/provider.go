// Package provider knows how to address each upstream LLM provider:
// default base URLs, how to build the target URL and how to authenticate.
package provider

import (
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

// Kind groups providers by wire protocol.
type Kind string

const (
	KindOpenAI    Kind = "openai"    // OpenAI-compatible chat/completions
	KindAnthropic Kind = "anthropic" // Anthropic Messages API
	KindAzure     Kind = "azure"     // Azure OpenAI (api-key header, deployment URLs)
)

// defaultBaseURLs is used when a provider config has no base_url.
// Paths from clients keep their "v1/..." prefix; see TargetURL.
var defaultBaseURLs = map[string]string{
	"openai":     "https://api.openai.com",
	"anthropic":  "https://api.anthropic.com",
	"groq":       "https://api.groq.com/openai",
	"gemini":     "https://generativelanguage.googleapis.com/v1beta/openai",
	"mistral":    "https://api.mistral.ai",
	"deepseek":   "https://api.deepseek.com",
	"together":   "https://api.together.xyz",
	"openrouter": "https://openrouter.ai/api",
	"xai":        "https://api.x.ai",
	"ollama":     "http://localhost:11434",
}

// KindOf returns the wire protocol for a provider slug.
func KindOf(slug string) Kind {
	switch slug {
	case "anthropic":
		return KindAnthropic
	case "azure":
		return KindAzure
	default:
		return KindOpenAI
	}
}

// BaseURL returns the configured base URL or the provider's default.
func BaseURL(p snapshot.Provider) (string, bool) {
	if p.BaseURL != "" {
		return p.BaseURL, true
	}
	u, ok := defaultBaseURLs[p.Slug]
	return u, ok
}

var versionedPathRe = regexp.MustCompile(`/v\d+[a-z]*(/|$)`)

// TargetURL joins a base URL with the client's request path. When the base
// URL already carries a version segment (Gemini's .../v1beta/openai) or the
// provider is Azure, the client's leading "v1/" is dropped so it is not
// duplicated.
func TargetURL(p snapshot.Provider, base, path, rawQuery string) string {
	path = strings.TrimPrefix(path, "/")
	if KindOf(p.Slug) == KindAzure || versionedPathRe.MatchString(base) {
		path = strings.TrimPrefix(path, "v1/")
	}
	target := strings.TrimRight(base, "/") + "/" + path

	q, _ := url.ParseQuery(rawQuery)
	if KindOf(p.Slug) == KindAzure {
		if v, ok := p.Extra["api_version"].(string); ok && v != "" && q.Get("api-version") == "" {
			q.Set("api-version", v)
		}
	}
	if enc := q.Encode(); enc != "" {
		target += "?" + enc
	}
	return target
}

// SetAuth adds the provider credential to an upstream request.
func SetAuth(h http.Header, p snapshot.Provider) {
	switch KindOf(p.Slug) {
	case KindAnthropic:
		h.Set("x-api-key", p.APIKey)
		if h.Get("anthropic-version") == "" {
			h.Set("anthropic-version", "2023-06-01")
		}
	case KindAzure:
		h.Set("api-key", p.APIKey)
	default:
		if p.APIKey != "" {
			h.Set("Authorization", "Bearer "+p.APIKey)
		}
	}
}
