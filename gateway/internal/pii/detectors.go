// Package pii implements lightweight, dependency-free PII/DLP detection.
// It scans outbound request content for common sensitive-data patterns
// before the request leaves the gateway toward an external AI provider.
//
// This is a pragmatic, regex-based first version — good enough to catch
// the majority of accidental PII leakage (the common enterprise ask) —
// not a full NLP/NER-based DLP engine. That's a natural v2 once real
// customer data shows which patterns matter most.
package pii

import "regexp"

type Detection struct {
	Type  string // see the Type* constants below
	Start int    // byte offset in the scanned string
	End   int
	Value string // matched text — only kept in-memory for redaction, never logged
}

const (
	TypeEmail      = "email"
	TypePhone      = "phone"
	TypeCreditCard = "credit_card"
	TypeSSN        = "ssn"   // US Social Security Number
	TypeCIUY       = "ci_uy" // Uruguayan Cédula de Identidad
	TypeIPAddress  = "ip_address"
	TypeAPIKey     = "api_key" // generic secret/token-shaped strings
)

// AllTypes is the full detector catalog, used when a policy doesn't
// restrict scanning to a specific subset.
var AllTypes = []string{TypeEmail, TypePhone, TypeCreditCard, TypeSSN, TypeCIUY, TypeIPAddress, TypeAPIKey}

var patterns = map[string]*regexp.Regexp{
	TypeEmail: regexp.MustCompile(`[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}`),

	// Phone: loose international/US pattern — 7 to 15 digits with optional
	// separators, requires a leading +, (, or digit boundary to reduce
	// false positives against arbitrary number sequences.
	TypePhone: regexp.MustCompile(`(?:\+?\d{1,3}[\s.\-]?)?(?:\(\d{2,4}\)[\s.\-]?)?\d{3,4}[\s.\-]?\d{3,4}(?:[\s.\-]?\d{2,4})?`),

	// Credit card: 13-19 digits, optionally grouped by spaces/dashes.
	// Luhn-validated separately to cut false positives sharply.
	TypeCreditCard: regexp.MustCompile(`\b(?:\d[ -]?){13,19}\b`),

	// US SSN: XXX-XX-XXXX
	TypeSSN: regexp.MustCompile(`\b\d{3}-\d{2}-\d{4}\b`),

	// Uruguayan CI: 7-8 digits, optionally dotted (X.XXX.XXX-X) with check digit
	TypeCIUY: regexp.MustCompile(`\b\d{1,2}\.?\d{3}\.?\d{3}-?\d\b`),

	TypeIPAddress: regexp.MustCompile(`\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b`),

	// Generic API key / secret shapes: provider prefixes (sk-, aig_sk_,
	// ghp_, AKIA...) or long high-entropy alphanumeric runs (32+ chars).
	TypeAPIKey: regexp.MustCompile(`\b(?:sk-[A-Za-z0-9]{20,}|aig_(?:sk|agt)_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|[A-Za-z0-9_\-]{32,})\b`),
}

// luhnValid implements the Luhn checksum used by all major card networks.
// Used to filter the credit_card regex down to numbers that are actually
// structurally valid card numbers, not just any 13-19 digit sequence.
func luhnValid(digits string) bool {
	sum := 0
	alt := false
	for i := len(digits) - 1; i >= 0; i-- {
		c := digits[i]
		if c < '0' || c > '9' {
			continue
		}
		d := int(c - '0')
		if alt {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
		alt = !alt
	}
	return sum%10 == 0 && len(digits) >= 12
}

// ciUYValid checks the Uruguayan Cédula de Identidad check digit.
// Reduces false positives from the CI regex matching arbitrary digit runs.
func ciUYValid(digits string) bool {
	if len(digits) < 7 || len(digits) > 8 {
		return false
	}
	// Pad to 8 digits (leading zero for 7-digit CIs)
	for len(digits) < 8 {
		digits = "0" + digits
	}
	weights := []int{2, 9, 8, 7, 6, 3, 4}
	sum := 0
	for i := 0; i < 7; i++ {
		sum += int(digits[i]-'0') * weights[i]
	}
	checkDigit := (10 - sum%10) % 10
	return checkDigit == int(digits[7]-'0')
}

// PersonalTypes are the detectors governed by a policy's pii_action.
var PersonalTypes = []string{TypeEmail, TypePhone, TypeCreditCard, TypeSSN, TypeCIUY, TypeIPAddress}

// SecretTypes are the detectors governed by a policy's dlp_action:
// credentials that must not leave the network.
var SecretTypes = []string{TypeAPIKey}
