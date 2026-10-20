package metrics

import (
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"
)

func render(m *Metrics) string {
	var b strings.Builder
	m.WriteTo(&b, time.Now())
	return b.String()
}

func TestGenAIHistograms(t *testing.T) {
	m := New()
	m.GenAI(GenAIOp{Operation: "chat", Provider: "anthropic", Model: "claude-haiku-4-5", Seconds: 0.3, TokensIn: 120, TokensOut: 4})
	m.GenAI(GenAIOp{Operation: "chat", Provider: "anthropic", Model: "claude-haiku-4-5", Seconds: 2, TokensIn: 64, TokensOut: 900})
	m.GenAI(GenAIOp{Operation: "chat", Provider: "azure", Model: "gpt-5", ErrorType: "429", Seconds: 0.05})
	out := render(m)

	for _, want := range []string{
		`gen_ai_client_operation_duration_seconds_bucket{gen_ai_operation_name="chat",gen_ai_provider_name="anthropic",gen_ai_request_model="claude-haiku-4-5",le="0.32"} 1`,
		`gen_ai_client_operation_duration_seconds_bucket{gen_ai_operation_name="chat",gen_ai_provider_name="anthropic",gen_ai_request_model="claude-haiku-4-5",le="2.56"} 2`,
		`gen_ai_client_operation_duration_seconds_bucket{gen_ai_operation_name="chat",gen_ai_provider_name="anthropic",gen_ai_request_model="claude-haiku-4-5",le="+Inf"} 2`,
		`gen_ai_client_operation_duration_seconds_sum{gen_ai_operation_name="chat",gen_ai_provider_name="anthropic",gen_ai_request_model="claude-haiku-4-5"} 2.3`,
		// le is inclusive: 64 tokens fall in the 64 bucket.
		`gen_ai_client_token_usage_bucket{gen_ai_operation_name="chat",gen_ai_provider_name="anthropic",gen_ai_request_model="claude-haiku-4-5",gen_ai_token_type="input",le="64"} 1`,
		`gen_ai_client_token_usage_bucket{gen_ai_operation_name="chat",gen_ai_provider_name="anthropic",gen_ai_request_model="claude-haiku-4-5",gen_ai_token_type="input",le="256"} 2`,
		`gen_ai_client_token_usage_sum{gen_ai_operation_name="chat",gen_ai_provider_name="anthropic",gen_ai_request_model="claude-haiku-4-5",gen_ai_token_type="output"} 904`,
		`gen_ai_client_token_usage_count{gen_ai_operation_name="chat",gen_ai_provider_name="anthropic",gen_ai_request_model="claude-haiku-4-5",gen_ai_token_type="output"} 2`,
		// Failed requests have a duration and an error type, no tokens; Azure
		// OpenAI has its well-known provider name.
		`gen_ai_client_operation_duration_seconds_count{gen_ai_operation_name="chat",gen_ai_provider_name="azure.ai.openai",gen_ai_request_model="gpt-5",error_type="429"} 1`,
	} {
		if !strings.Contains(out, want+"\n") {
			t.Errorf("missing:\n%s", want)
		}
	}
	if strings.Contains(out, `gen_ai_request_model="gpt-5",gen_ai_token_type`) {
		t.Error("a failed request records no tokens")
	}

	// Every line is a comment or "name{labels} value": what Prometheus parses.
	line := regexp.MustCompile(`^(# (HELP|TYPE) .+|[a-z_:][a-z0-9_:]*(\{([a-z_][a-z0-9_]*="(\\.|[^"\\])*",?)*\})? -?[0-9.e+Inf-]+)$`)
	for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
		if !line.MatchString(l) {
			t.Fatalf("not exposition format: %q", l)
		}
	}
}

func TestGenAISeriesAreBounded(t *testing.T) {
	m := New()
	for i := 0; i < maxGenAISeries+50; i++ {
		m.GenAI(GenAIOp{Operation: "chat", Provider: "openai", Model: fmt.Sprintf("made-up-%d", i), Seconds: 0.1})
	}
	m.genai.mu.Lock()
	n := len(m.genai.duration)
	m.genai.mu.Unlock()
	if n > maxGenAISeries+1 {
		t.Fatalf("%d series", n)
	}
	if !strings.Contains(render(m), `gen_ai_request_model="_other"} 50`) {
		t.Error("models past the limit are counted as _other")
	}
}
