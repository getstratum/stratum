package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestClientIP(t *testing.T) {
	lb := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	req := func(remote string, xff ...string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
		r.RemoteAddr = remote
		for _, v := range xff {
			r.Header.Add("X-Forwarded-For", v)
		}
		return r
	}
	for _, c := range []struct {
		name string
		r    *http.Request
		tr   []netip.Prefix
		want string
	}{
		{"the connection, without proxies", req("203.0.113.7:51000"), nil, "203.0.113.7"},
		{"a header from anyone else is not believed", req("203.0.113.7:51000", "198.51.100.1"), lb, "203.0.113.7"},
		{"behind a trusted proxy: the client it saw", req("10.1.2.3:443", "198.51.100.9"), lb, "198.51.100.9"},
		{"a client that writes its own header does not hide behind it", req("10.1.2.3:443", "1.2.3.4, 198.51.100.9"), lb, "198.51.100.9"},
		{"several trusted hops, several headers", req("10.1.2.3:443", "198.51.100.9", "10.9.9.9"), lb, "198.51.100.9"},
		{"only trusted hops: the farthest", req("10.1.2.3:443", "10.4.4.4"), lb, "10.4.4.4"},
		{"a malformed hop: the last known address", req("10.1.2.3:443", "nonsense, 10.4.4.4"), lb, "10.4.4.4"},
		{"IPv6 and IPv4-mapped", req("[::ffff:203.0.113.7]:51000"), nil, "203.0.113.7"},
		{"no address", req("pipe"), nil, ""},
	} {
		if got := clientIP(c.r, c.tr); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestClientAgent(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.Header.Set("User-Agent", "daty-worker/1.4 \x01(cron)\n"+strings.Repeat("x", 300))
	got := clientAgent(r)
	if !strings.HasPrefix(got, "daty-worker/1.4 (cron)") || len(got) != 200 {
		t.Fatalf("agent = %q (%d)", got, len(got))
	}
}

// The origin reaches the usage record, and stays out when told to.
func TestOriginInTheUsageRecord(t *testing.T) {
	send := func(e *env) {
		req, _ := http.NewRequest(http.MethodPost, e.gw.URL+"/v1/chat/completions", strings.NewReader(`{"model":"openai/gpt-4o","messages":[]}`))
		req.Header.Set("Authorization", "Bearer "+devKey)
		req.Header.Set("User-Agent", "daty-worker/1.4")
		req.Header.Set("X-Forwarded-For", "198.51.100.9")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
	}
	e := newEnv(t, allowAll, time.Minute, func(h *Handler) {
		h.RecordClient = true
		h.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	})
	send(e)
	if r := e.usage.wait(t, 1)[0]; r.ClientIP != "198.51.100.9" || r.UserAgent != "daty-worker/1.4" {
		t.Fatalf("record origin = %q %q", r.ClientIP, r.UserAgent)
	}
	off := newEnv(t, allowAll, time.Minute)
	send(off)
	if r := off.usage.wait(t, 1)[0]; r.ClientIP != "" || r.UserAgent != "" {
		t.Fatalf("recorded while off: %q %q", r.ClientIP, r.UserAgent)
	}
}
