package metrics

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"sync"
)

// GenAI client metrics, as the OpenTelemetry semantic conventions for
// generative AI define them, in the names an OpenTelemetry Collector would
// give them in Prometheus:
//
//	gen_ai.client.token.usage        → gen_ai_client_token_usage (histogram, tokens)
//	gen_ai.client.operation.duration → gen_ai_client_operation_duration_seconds (histogram)
//
// with the attributes gen_ai.operation.name, gen_ai.provider.name,
// gen_ai.request.model, gen_ai.token.type and error.type as labels. The
// gateway is the client: one observation per request it sent to a provider.
// The bucket boundaries are the ones the conventions recommend.
//
// The model comes from the request, so a client could send any number of
// names: past maxGenAISeries label sets a metric records new models as
// "_other".

var (
	tokenBuckets    = []float64{1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864}
	durationBuckets = []float64{0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92}
)

const maxGenAISeries = 1000

// GenAIOp is one request to a provider, as the gateway saw it.
type GenAIOp struct {
	Operation string // chat, text_completion, embeddings, ... (gen_ai.operation.name)
	Provider  string // the provider's slug in Stratum
	Model     string // as requested (after an agent's fixed model)
	ErrorType string // empty when it succeeded
	Seconds   float64
	TokensIn  int64 // 0 when the provider reported no usage
	TokensOut int64
}

type genAIKey struct{ op, provider, model, tokenType, errType string }

type histogram struct {
	counts []uint64 // per bucket, not cumulative; the last is +Inf
	sum    float64
	n      uint64
}

func (h *histogram) observe(bounds []float64, v float64) {
	if h.counts == nil {
		h.counts = make([]uint64, len(bounds)+1)
	}
	i, _ := slices.BinarySearch(bounds, v) // first bound >= v: le is inclusive
	h.counts[i]++
	h.sum += v
	h.n++
}

type genAI struct {
	mu       sync.Mutex
	tokens   map[genAIKey]*histogram
	duration map[genAIKey]*histogram
}

// ProviderName maps a Stratum provider slug to gen_ai.provider.name, using
// the conventions' well-known values where there is one.
func ProviderName(slug string) string {
	switch slug {
	case "azure":
		return "azure.ai.openai"
	case "gemini", "google", "google-gemini":
		return "gcp.gemini"
	case "vertex", "vertex-ai":
		return "gcp.vertex_ai"
	case "bedrock", "aws-bedrock":
		return "aws.bedrock"
	case "mistral":
		return "mistral_ai"
	case "xai", "x-ai", "grok":
		return "x_ai"
	case "watsonx":
		return "ibm.watsonx.ai"
	}
	return slug
}

// GenAI records one request sent to a provider.
func (m *Metrics) GenAI(op GenAIOp) {
	g := &m.genai
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.tokens == nil {
		g.tokens, g.duration = map[genAIKey]*histogram{}, map[genAIKey]*histogram{}
	}
	base := genAIKey{op: op.Operation, provider: ProviderName(op.Provider), model: op.Model, errType: op.ErrorType}
	limit := func(set map[genAIKey]*histogram, k genAIKey) *histogram {
		h, ok := set[k]
		if !ok {
			if len(set) >= maxGenAISeries {
				k.model = "_other"
				if h, ok = set[k]; ok {
					return h
				}
			}
			h = &histogram{}
			set[k] = h
		}
		return h
	}
	limit(g.duration, base).observe(durationBuckets, op.Seconds)
	if op.ErrorType == "" {
		for _, t := range []struct {
			typ string
			n   int64
		}{{"input", op.TokensIn}, {"output", op.TokensOut}} {
			if t.n > 0 {
				k := base
				k.tokenType = t.typ
				limit(g.tokens, k).observe(tokenBuckets, float64(t.n))
			}
		}
	}
}

func (g *genAI) write(b *strings.Builder) {
	g.mu.Lock()
	defer g.mu.Unlock()
	b.WriteString("# HELP gen_ai_client_token_usage Tokens per request sent to a provider, input and output (OpenTelemetry gen_ai.client.token.usage).\n")
	b.WriteString("# TYPE gen_ai_client_token_usage histogram\n")
	writeHistograms(b, "gen_ai_client_token_usage", g.tokens, tokenBuckets)
	b.WriteString("# HELP gen_ai_client_operation_duration_seconds Duration of requests sent to a provider, streams to their end (OpenTelemetry gen_ai.client.operation.duration).\n")
	b.WriteString("# TYPE gen_ai_client_operation_duration_seconds histogram\n")
	writeHistograms(b, "gen_ai_client_operation_duration_seconds", g.duration, durationBuckets)
}

func writeHistograms(b *strings.Builder, name string, set map[genAIKey]*histogram, bounds []float64) {
	keys := make([]genAIKey, 0, len(set))
	for k := range set {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, c genAIKey) int {
		return strings.Compare(a.provider+"\x00"+a.model+"\x00"+a.op+"\x00"+a.tokenType+"\x00"+a.errType,
			c.provider+"\x00"+c.model+"\x00"+c.op+"\x00"+c.tokenType+"\x00"+c.errType)
	})
	for _, k := range keys {
		h := set[k]
		labels := fmt.Sprintf("gen_ai_operation_name=%q,gen_ai_provider_name=%q,gen_ai_request_model=%q", k.op, k.provider, k.model)
		if k.tokenType != "" {
			labels += fmt.Sprintf(",gen_ai_token_type=%q", k.tokenType)
		}
		if k.errType != "" {
			labels += fmt.Sprintf(",error_type=%q", k.errType)
		}
		var cum uint64
		for i, bound := range bounds {
			cum += h.counts[i]
			fmt.Fprintf(b, "%s_bucket{%s,le=%q} %d\n", name, labels, strconv.FormatFloat(bound, 'g', -1, 64), cum)
		}
		cum += h.counts[len(bounds)]
		fmt.Fprintf(b, "%s_bucket{%s,le=\"+Inf\"} %d\n", name, labels, cum)
		fmt.Fprintf(b, "%s_sum{%s} %s\n", name, labels, strconv.FormatFloat(h.sum, 'g', -1, 64))
		fmt.Fprintf(b, "%s_count{%s} %d\n", name, labels, h.n)
	}
}
