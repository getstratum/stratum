package pii

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestScanJSON_DetectsEmail(t *testing.T) {
	body := `{"messages":[{"role":"user","content":"Contact me at john.doe@acme.com please"}]}`
	res, err := ScanJSON([]byte(body), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Flagged {
		t.Fatal("expected email to be flagged")
	}
	if !contains(res.Types, TypeEmail) {
		t.Fatalf("expected email type in %v", res.Types)
	}
}

func TestScanJSON_DetectsValidCreditCard(t *testing.T) {
	// 4111111111111111 is a well-known Luhn-valid test Visa number
	body := `{"messages":[{"role":"user","content":"My card is 4111111111111111 expiring soon"}]}`
	res, err := ScanJSON([]byte(body), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(res.Types, TypeCreditCard) {
		t.Fatalf("expected credit_card type in %v", res.Types)
	}
}

func TestScanJSON_RejectsInvalidLuhn(t *testing.T) {
	// 16 digits but fails Luhn — should NOT be flagged as a credit card
	body := `{"messages":[{"role":"user","content":"Random number 1234567812345678 in text"}]}`
	res, err := ScanJSON([]byte(body), nil)
	if err != nil {
		t.Fatal(err)
	}
	if contains(res.Types, TypeCreditCard) {
		t.Fatalf("did not expect credit_card for Luhn-invalid number, got %v", res.Types)
	}
}

func TestScanJSON_DetectsCIUruguaya(t *testing.T) {
	// Valid Uruguayan CI with correct check digit: 1.234.567-2
	body := `{"messages":[{"role":"user","content":"Mi CI es 1.234.567-2"}]}`
	res, err := ScanJSON([]byte(body), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(res.Types, TypeCIUY) {
		t.Fatalf("expected ci_uy type in %v", res.Types)
	}
}

func TestScanJSON_NoFalsePositiveOnCleanText(t *testing.T) {
	body := `{"messages":[{"role":"user","content":"What is the capital of France?"}]}`
	res, err := ScanJSON([]byte(body), nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Flagged {
		t.Fatalf("expected no PII, got %v", res.Types)
	}
}

func TestScanJSON_RespectsTypeFilter(t *testing.T) {
	// Email present, but policy only scans for credit_card
	body := `{"messages":[{"role":"user","content":"Email me at a@b.com"}]}`
	res, err := ScanJSON([]byte(body), []string{TypeCreditCard})
	if err != nil {
		t.Fatal(err)
	}
	if res.Flagged {
		t.Fatalf("expected no flag when email type is excluded, got %v", res.Types)
	}
}

func TestRedactJSON_ReplacesDetectedPII(t *testing.T) {
	body := `{"messages":[{"role":"user","content":"Email me at john@acme.com"}]}`
	redacted, res, err := RedactJSON([]byte(body), []string{TypeEmail})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Flagged {
		t.Fatal("expected flagged result")
	}

	var parsed map[string]any
	if err := json.Unmarshal(redacted, &parsed); err != nil {
		t.Fatal(err)
	}
	msgs := parsed["messages"].([]any)
	content := msgs[0].(map[string]any)["content"].(string)

	if contains([]string{content}, "john@acme.com") {
		t.Fatalf("expected email to be redacted, got: %s", content)
	}
	if !contains([]string{content}, "[REDACTED:EMAIL]") {
		t.Fatalf("expected [REDACTED:EMAIL] marker, got: %s", content)
	}
}

func contains(list []string, needle string) bool {
	for _, s := range list {
		if s == needle {
			return true
		}
		// substring check for the redaction test's marker lookup
		if len(s) >= len(needle) && indexOf(s, needle) >= 0 {
			return true
		}
	}
	return false
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}

func TestRedactJSON_PreservesLargeIntegers(t *testing.T) {
	body := `{"seed":9007199254740993,"messages":[{"role":"user","content":"mail me: a@b.co"}]}`
	out, _, err := RedactJSON([]byte(body), []string{TypeEmail})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "9007199254740993") {
		t.Fatalf("large integer was altered: %s", out)
	}
	if strings.Contains(string(out), "a@b.co") {
		t.Fatalf("email not redacted: %s", out)
	}
}

// A card number also matches the loose phone pattern in its first digits.
// Both replacements used to apply, the second on shifted offsets, and two
// digits of the card reached the provider; and the card was flagged as a
// phone too.
func TestRedactJSON_OverlappingDetections(t *testing.T) {
	text := "Escribime a juana.perez@ejemplo.com, mi tarjeta es 4111 1111 1111 1111."
	if got := scanText(text, enabledSet(PersonalTypes)); len(got) != 2 || got[0].Type != TypeEmail || got[1].Type != TypeCreditCard {
		t.Fatalf("detections = %+v, want an email and a card", got)
	}
	body, _ := json.Marshal(map[string]any{"messages": []any{map[string]any{"role": "user", "content": text}}})
	redacted, res, err := RedactJSON(body, PersonalTypes)
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Messages []struct{ Content string } `json:"messages"`
	}
	if err := json.Unmarshal(redacted, &parsed); err != nil {
		t.Fatal(err)
	}
	want := "Escribime a [REDACTED:EMAIL], mi tarjeta es [REDACTED:CREDIT_CARD]."
	if got := parsed.Messages[0].Content; got != want {
		t.Fatalf("redacted = %q, want %q", got, want)
	}
	if strings.Join(res.Types, ",") != "email,credit_card" {
		t.Fatalf("types = %v, want email and credit_card only", res.Types)
	}
}

// A match that starts inside another and runs past it extends the
// redacted stretch: no character of either reaches the provider.
func TestDisjoint_ExtendsPartialOverlap(t *testing.T) {
	text := "abcdefghij"
	got := disjoint(text, []Detection{
		{Type: TypePhone, Start: 4, End: 9},
		{Type: TypeCreditCard, Start: 1, End: 6},
		{Type: TypeEmail, Start: 9, End: 10},
	})
	if len(got) != 2 || got[0].Type != TypeCreditCard || got[0].Start != 1 || got[0].End != 9 || got[0].Value != "bcdefghi" {
		t.Fatalf("got %+v, want card 1-9 then email 9-10", got)
	}
	if out := redactText(text, got); out != "a[REDACTED:CREDIT_CARD][REDACTED:EMAIL]" {
		t.Fatalf("redacted = %q", out)
	}
}
