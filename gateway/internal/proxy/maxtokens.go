package proxy

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/getstratum/stratum/gateway/internal/provider"
)

// capOutputTokens enforces a policy's maximum output tokens per request on
// the body, in place. A request that asks for more is lowered to the limit;
// one that asks for nothing gets the limit, in the field its API uses, so
// leaving it out does not mean "as many as the model allows". Paths that do
// not generate text (embeddings, models, ...) are left alone. It reports
// whether the body changed.
//
//	Anthropic Messages (v1/messages)    max_tokens
//	OpenAI Responses (.../responses)    max_output_tokens
//	OpenAI-compatible chat/completions  max_tokens and max_completion_tokens; when
//	                                    neither is sent, max_completion_tokens for
//	                                    OpenAI and Azure (their reasoning models
//	                                    refuse max_tokens) and max_tokens elsewhere
func capOutputTokens(body map[string]any, upstreamPath, slug string, kind provider.Kind, limit int64) bool {
	p := strings.TrimSuffix(upstreamPath, "/")
	var fields []string
	var absent string
	switch {
	case kind == provider.KindAnthropic:
		if !strings.HasSuffix(p, "messages") {
			return false
		}
		fields, absent = []string{"max_tokens"}, "max_tokens"
	case strings.HasSuffix(p, "/responses") || p == "responses":
		fields, absent = []string{"max_output_tokens"}, "max_output_tokens"
	case strings.HasSuffix(p, "chat/completions") || strings.HasSuffix(p, "/completions") || p == "completions":
		fields, absent = []string{"max_tokens", "max_completion_tokens"}, "max_tokens"
		if kind == provider.KindAzure || strings.EqualFold(slug, "openai") {
			absent = "max_completion_tokens"
		}
	default:
		return false
	}

	changed, any := false, false
	for _, f := range fields {
		v, ok := body[f]
		if !ok || v == nil {
			continue
		}
		any = true
		if n, ok := asInt(v); !ok || n > limit {
			// Above the limit, or not a number the provider would accept
			// anyway: the limit is what goes.
			body[f] = json.Number(strconv.FormatInt(limit, 10))
			changed = true
		}
	}
	if !any {
		body[absent] = json.Number(strconv.FormatInt(limit, 10))
		changed = true
	}
	return changed
}

func asInt(v any) (int64, bool) {
	switch n := v.(type) {
	case json.Number:
		if i, err := n.Int64(); err == nil {
			return i, true
		}
		if f, err := n.Float64(); err == nil && f >= 0 {
			return int64(f), true
		}
	case float64:
		return int64(n), true
	}
	return 0, false
}
