package trace

import (
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"
)

// Sampler is one of the OpenTelemetry SDK's standard samplers
// (OTEL_TRACES_SAMPLER and OTEL_TRACES_SAMPLER_ARG).
type Sampler struct {
	Name  string  // always_on, always_off, traceidratio, parentbased_*
	Ratio float64 // for the traceidratio ones
}

// ParseSampler reads the two variables; empty name: parentbased_always_on.
func ParseSampler(name, arg string) (Sampler, error) {
	s := Sampler{Name: strings.ToLower(strings.TrimSpace(name)), Ratio: 1}
	if s.Name == "" {
		s.Name = "parentbased_always_on"
	}
	switch s.Name {
	case "always_on", "always_off", "parentbased_always_on", "parentbased_always_off":
	case "traceidratio", "parentbased_traceidratio":
		if a := strings.TrimSpace(arg); a != "" {
			r, err := strconv.ParseFloat(a, 64)
			if err != nil || r < 0 || r > 1 {
				return s, fmt.Errorf("OTEL_TRACES_SAMPLER_ARG: %q is not a ratio between 0 and 1", arg)
			}
			s.Ratio = r
		}
	default:
		return s, fmt.Errorf("OTEL_TRACES_SAMPLER: %q is not supported (always_on, always_off, traceidratio and their parentbased_ forms)", name)
	}
	return s, nil
}

// Sample decides for a span of traceID; a parent's decision wins in the
// parentbased forms.
func (s Sampler) Sample(parent SpanContext, hasParent bool, traceID [16]byte) bool {
	if hasParent && strings.HasPrefix(s.Name, "parentbased_") {
		return parent.Sampled
	}
	switch strings.TrimPrefix(s.Name, "parentbased_") {
	case "always_on":
		return true
	case "always_off":
		return false
	default:
		// The SDKs' rule: the trace ID's last 8 bytes against the ratio, so
		// every service that sees the trace decides the same.
		bound := uint64(s.Ratio * (1 << 63))
		return binary.BigEndian.Uint64(traceID[8:])>>1 < bound
	}
}
