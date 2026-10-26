package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

func TestModelsRoute(t *testing.T) {
	named := func(name string) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, name) })
	}
	o := opts(named("proxy"), &snapshot.Holder{})
	o.Models = named("models")
	o.Instructions = named("instructions")
	srv := httptest.NewServer(Public(o))
	defer srv.Close()

	call := func(method, path string) string {
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader("{}"))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return string(b)
	}
	if got := call(http.MethodGet, "/v1/models"); got != "models" {
		t.Errorf("GET /v1/models went to %q", got)
	}
	if got := call(http.MethodPost, "/v1/chat/completions"); got != "proxy" {
		t.Errorf("POST /v1/chat/completions went to %q", got)
	}
	if got := call(http.MethodGet, "/v1/stratum/instructions"); got != "instructions" {
		t.Errorf("GET /v1/stratum/instructions went to %q", got)
	}
	if got := call(http.MethodGet, "/v1/models/gpt-4o"); got != "proxy" {
		t.Errorf("other paths stay with the proxy, got %q", got)
	}
}
