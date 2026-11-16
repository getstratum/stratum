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

// An inline image is base64: digits that look like a phone or a card, and
// letters that look like a key. It is not scanned, so it is not flagged and
// redaction does not corrupt it; the text around it still is.
func TestInlineFilesAreNotScanned(t *testing.T) {
	blob := "iVBORw0KGgo4111111111111111AKIAIOSFODNN7EXAMPLE+59899123456/0987654321=="
	bodies := []string{
		// OpenAI: a data: URI in image_url.
		`{"messages":[{"role":"user","content":[{"type":"text","text":"mail juana@ejemplo.com"},` +
			`{"type":"image_url","image_url":{"url":"data:image/png;base64,` + blob + `"}}]}]}`,
		// Anthropic: an image source.
		`{"messages":[{"role":"user","content":[{"type":"text","text":"mail juana@ejemplo.com"},` +
			`{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + blob + `"}}]}]}`,
		// Gemini: inline_data.
		`{"contents":[{"parts":[{"text":"mail juana@ejemplo.com"},{"inline_data":{"mime_type":"image/png","data":"` + blob + `"}}]}]}`,
	}
	all := append(append([]string{}, PersonalTypes...), SecretTypes...)
	for i, body := range bodies {
		res, err := ScanJSON([]byte(body), all)
		if err != nil {
			t.Fatal(err)
		}
		if len(res.Types) != 1 || res.Types[0] != "email" {
			t.Errorf("body %d: flagged %v, want only the email", i, res.Types)
		}
		out, _, err := RedactJSON([]byte(body), all)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(out), blob) || strings.Contains(string(out), "juana@ejemplo.com") {
			t.Errorf("body %d: redacted %s", i, out)
		}
	}
	// A data: URI that is not base64 is text like any other.
	if res, _ := ScanJSON([]byte(`{"x":"data:text/plain,juana@ejemplo.com"}`), all); len(res.Types) != 1 {
		t.Errorf("plain data URI: %v", res.Types)
	}
}

func TestToolCallIdsAndSignaturesAreNotScanned(t *testing.T) {
	secret := "sk-abcdefghijklmnopqrstuvwxyz0123456789"
	// A tool step as the Enterprise portal sends it back (F4 of the 0.8
	// tests): Groq's call id and Gemini's signature look like keys.
	body := `{"messages":[{"role":"user","content":"hora"},` +
		`{"role":"assistant","content":null,"tool_calls":[{"id":"fc_9a1f0e3c-1b2a-4c3d-8e9f-0a1b2c3d4e5f","type":"function",` +
		`"function":{"name":"demo__hora","arguments":"{}"},"extra_content":{"google":{"thought_signature":"CiQBvj72+3kqZ0P1mN8x5Yq7uG6v2Wb9EjR0aSdFgHjKlZxCvBnMq"}}}]},` +
		`{"role":"tool","tool_call_id":"fc_9a1f0e3c-1b2a-4c3d-8e9f-0a1b2c3d4e5f","content":"Son las 15:10 UTC."},` +
		`{"role":"assistant","content":[{"type":"thinking","thinking":"…","signature":"EqoBCkgIARABGAIiQAx1Yz2W3v4U5t6S7r8Q9p0O1n2M3l4K5j6I7h8G9f0E"}]}]}`
	if res, err := ScanJSON([]byte(body), []string{TypeAPIKey}); err != nil || res.Flagged {
		t.Fatalf("ids and signatures flagged: %+v %v", res, err)
	}
	// A key in a call's arguments or in a tool's result still is.
	for _, b := range []string{
		strings.Replace(body, `"arguments":"{}"`, `"arguments":"{\"k\":\"`+secret+`\"}"`, 1),
		strings.Replace(body, "Son las 15:10 UTC.", "la clave es "+secret, 1),
		// "signature" or "id" elsewhere is content.
		`{"messages":[{"role":"user","content":[{"type":"text","text":"x","signature":"` + secret + `"}]}]}`,
		`{"input":{"id":"` + secret + `"}}`,
	} {
		if res, _ := ScanJSON([]byte(b), []string{TypeAPIKey}); !res.Flagged {
			t.Errorf("not flagged: %s", b)
		}
	}
	// Redaction leaves them as they came.
	out, _, err := RedactJSON([]byte(body), []string{TypeAPIKey})
	if err != nil || !strings.Contains(string(out), "fc_9a1f0e3c-1b2a-4c3d-8e9f-0a1b2c3d4e5f") || !strings.Contains(string(out), "CiQBvj72+3kqZ0P1mN8x5Yq7uG6v2Wb9EjR0aSdFgHjKlZxCvBnMq") {
		t.Errorf("redacted: %s", out)
	}
}

func TestNamesMadeOfWordsAreNotKeys(t *testing.T) {
	// F7 of the 0.8 tests: docker ps through an MCP server, its result sent
	// to the model, was blocked as a secret for its container names.
	notKeys := []string{
		"stratum-demo-enterprise-stratum-gateway-1",
		"stratum-demo-enterprise-stratum-console-1   Up 2 hours   0.0.0.0:3000->3000/tcp",
		"kube-prometheus-stack-prometheus-node-exporter-x2kq4",
		"550e8400-e29b-41d4-a716-446655440000",
		"fc_9a1f0e3c-1b2a-4c3d-8e9f-0a1b2c3d4e5f",
		"abcdefghijklmnopqrstuvwxyzabcdefgh", // letters only
	}
	for _, s := range notKeys {
		if d := scanText(s, map[string]bool{TypeAPIKey: true}); len(d) != 0 {
			t.Errorf("%q flagged: %+v", s, d)
		}
	}
	keys := []string{
		"sk-proj-abcdefghijklmnopqrstuvwx",
		// Built here so secret scanning does not take them for real keys.
		"sk_" + "live_" + "51HxYzAbCdEfGhIjKlMnOpQrStUvWx",
		"gh" + "p_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
		"AKIAIOSFODNN7EXAMPLE",
		"token: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
		"stratum-demo-Zx81kQp0LmN3vB7cR2tY9wE4",
	}
	for _, s := range keys {
		if d := scanText(s, map[string]bool{TypeAPIKey: true}); len(d) == 0 {
			t.Errorf("%q not flagged", s)
		}
	}
}

func TestPhonesStandOnTheirOwn(t *testing.T) {
	// F5 of the 0.8 tests: the guard's approval id reached the person as
	// ap_[REDACTED:PHONE]6, through the model.
	notPhones := []string{
		"el pedido ap_4088b3752e56 está en el portal",
		"ap_d90f85987696",
		"commit 9f86d0818847c659",
		"imagen sha256:12345678abcd",
	}
	for _, s := range notPhones {
		if d := scanText(s, map[string]bool{TypePhone: true}); len(d) != 0 {
			t.Errorf("%q flagged: %+v", s, d)
		}
	}
	phones := []string{"llamame al 099 123 456", "tel: +598 99 123 456", "(02) 2901 2345", "099123456."}
	for _, s := range phones {
		if d := scanText(s, map[string]bool{TypePhone: true}); len(d) == 0 {
			t.Errorf("%q not flagged", s)
		}
	}
}
