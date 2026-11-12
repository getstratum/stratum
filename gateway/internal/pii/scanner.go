package pii

import (
	"bytes"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
)

// Result is what a scan of a full request body produces.
type Result struct {
	Flagged bool
	Types   []string // deduplicated, sorted-by-first-seen list of PII types found
}

// nonDigit strips separators so Luhn/CI checks run against pure digits.
var nonDigit = regexp.MustCompile(`[^\d]`)

// scanText runs every enabled detector against a single string value and
// returns the matches, filtered by their respective validators.
func scanText(text string, enabledTypes map[string]bool) []Detection {
	var out []Detection

	for _, typ := range AllTypes {
		if !enabledTypes[typ] {
			continue
		}
		re := patterns[typ]
		for _, loc := range re.FindAllStringIndex(text, -1) {
			match := text[loc[0]:loc[1]]

			switch typ {
			case TypeCreditCard:
				if !luhnValid(nonDigit.ReplaceAllString(match, "")) {
					continue
				}
			case TypeCIUY:
				if !ciUYValid(nonDigit.ReplaceAllString(match, "")) {
					continue
				}
			}

			out = append(out, Detection{Type: typ, Start: loc[0], End: loc[1], Value: match})
		}
	}
	return disjoint(text, out)
}

// rank orders detectors for the same text: the more specific (validated)
// one names it. "4111 1111 1111 1111" is a card, not the phone number the
// loose phone pattern also finds in its first 14 characters.
var rank = map[string]int{
	TypeEmail: 0, TypeCreditCard: 1, TypeSSN: 2, TypeCIUY: 3, TypeAPIKey: 4, TypeIPAddress: 5, TypePhone: 6,
}

// disjoint turns detections that overlap into one, so redaction replaces
// each stretch of text once. Replacing two overlapping matches one after
// the other used offsets the first replacement had shifted, and left part
// of the data in the text ("[REDACTED:CREDIT_CARD]11"). The first match,
// then the longest, then the most specific, names the stretch; a match
// that runs past it extends it.
func disjoint(text string, dets []Detection) []Detection {
	if len(dets) < 2 {
		return dets
	}
	sort.SliceStable(dets, func(i, j int) bool {
		a, b := dets[i], dets[j]
		if a.Start != b.Start {
			return a.Start < b.Start
		}
		if la, lb := a.End-a.Start, b.End-b.Start; la != lb {
			return la > lb
		}
		return rank[a.Type] < rank[b.Type]
	})
	out := dets[:1]
	for _, d := range dets[1:] {
		last := &out[len(out)-1]
		if d.Start >= last.End {
			out = append(out, d)
			continue
		}
		if d.End > last.End {
			last.End = d.End
			last.Value = text[last.Start:last.End]
		}
	}
	return out
}

// redactText replaces each detection with a [REDACTED:TYPE] marker,
// processing right-to-left so earlier byte offsets stay valid. The
// detections must not overlap (scanText makes them disjoint).
func redactText(text string, detections []Detection) string {
	if len(detections) == 0 {
		return text
	}
	// Sort by Start descending (simple insertion — detection lists are small)
	for i := 1; i < len(detections); i++ {
		for j := i; j > 0 && detections[j].Start > detections[j-1].Start; j-- {
			detections[j], detections[j-1] = detections[j-1], detections[j]
		}
	}
	for _, d := range detections {
		marker := "[REDACTED:" + strings.ToUpper(d.Type) + "]"
		text = text[:d.Start] + marker + text[d.End:]
	}
	return text
}

func enabledSet(types []string) map[string]bool {
	m := make(map[string]bool, len(types))
	if len(types) == 0 {
		for _, t := range AllTypes {
			m[t] = true // no explicit list → scan for everything
		}
		return m
	}
	for _, t := range types {
		m[t] = true
	}
	return m
}

// ScanJSON walks a raw JSON request body, scanning every string leaf value
// for PII. Structural JSON (keys, punctuation) is never scanned, which
// keeps false positives low and redaction precise.
func ScanJSON(rawBody []byte, types []string) (Result, error) {
	parsed, err := decode(rawBody)
	if err != nil {
		return Result{}, err
	}

	enabled := enabledSet(types)
	seen := map[string]bool{}
	var order []string

	walkStrings(parsed, func(s string) {
		for _, d := range scanText(s, enabled) {
			if !seen[d.Type] {
				seen[d.Type] = true
				order = append(order, d.Type)
			}
		}
	})

	return Result{Flagged: len(order) > 0, Types: order}, nil
}

// RedactJSON returns a copy of the JSON body with every detected PII
// string leaf redacted in place. Used when policy action = "redact".
func RedactJSON(rawBody []byte, types []string) ([]byte, Result, error) {
	parsed, err := decode(rawBody)
	if err != nil {
		return rawBody, Result{}, err
	}

	enabled := enabledSet(types)
	seen := map[string]bool{}
	var order []string

	redacted := transformStrings(parsed, func(s string) string {
		dets := scanText(s, enabled)
		if len(dets) == 0 {
			return s
		}
		for _, d := range dets {
			if !seen[d.Type] {
				seen[d.Type] = true
				order = append(order, d.Type)
			}
		}
		return redactText(s, dets)
	})

	out, err := json.Marshal(redacted)
	return out, Result{Flagged: len(order) > 0, Types: order}, err
}

// walkStrings visits every string leaf in a decoded JSON value tree.
func walkStrings(v any, fn func(string)) {
	switch val := v.(type) {
	case string:
		fn(val)
	case []any:
		for _, item := range val {
			walkStrings(item, fn)
		}
	case map[string]any:
		for _, item := range val {
			walkStrings(item, fn)
		}
	}
}

// transformStrings rebuilds a decoded JSON value tree, replacing every
// string leaf with fn(leaf). Used to produce the redacted body.
func transformStrings(v any, fn func(string) string) any {
	switch val := v.(type) {
	case string:
		return fn(val)
	case []any:
		out := make([]any, len(val))
		for i, item := range val {
			out[i] = transformStrings(item, fn)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(val))
		for k, item := range val {
			out[k] = transformStrings(item, fn)
		}
		return out
	default:
		return v
	}
}

// decode parses JSON keeping numbers as json.Number, so re-encoding a
// redacted body does not turn large integers (seeds, ids) into floats.
func decode(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}
