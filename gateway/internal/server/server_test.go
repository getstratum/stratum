package server

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/health"
	"github.com/getstratum/stratum/gateway/internal/metrics"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

func opts(proxy http.Handler, holder *snapshot.Holder) Options {
	return Options{
		Proxy:          proxy,
		Health:         &health.Health{Holder: holder, Version: "test"},
		Metrics:        metrics.New(),
		Log:            slog.New(slog.NewTextHandler(io.Discard, nil)),
		MaxInflight:    1,
		AllowedOrigins: []string{"http://localhost:3000"},
	}
}

func TestReadinessIgnoresDependenciesButHonoursDraining(t *testing.T) {
	holder := &snapshot.Holder{}
	o := opts(http.NotFoundHandler(), holder)
	srv := httptest.NewServer(Public(o))
	defer srv.Close()

	get := func(p string) int {
		res, err := http.Get(srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if get("/livez") != 200 {
		t.Fatal("liveness must not depend on configuration")
	}
	if get("/readyz") != 503 {
		t.Fatal("not ready before the first snapshot")
	}
	st := snapshot.NewState()
	holder.Store(st, snapshot.Build(st, time.Now().Add(-48*time.Hour)))
	if get("/readyz") != 200 {
		t.Fatal("a 48h-old snapshot is still a valid snapshot: readiness must pass")
	}
	o.Health.SetDraining()
	if get("/readyz") != 503 || get("/livez") != 200 {
		t.Fatal("draining fails readiness only")
	}
}

func TestLimiterShedsLoad(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	slow := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
	})
	o := opts(slow, &snapshot.Holder{})
	srv := httptest.NewServer(Public(o))
	defer srv.Close()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		res, err := http.Post(srv.URL+"/v1/chat/completions", "application/json", strings.NewReader("{}"))
		if err == nil {
			res.Body.Close()
		}
	}()
	<-entered

	res, err := http.Post(srv.URL+"/v1/chat/completions", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 503 || res.Header.Get("Retry-After") == "" {
		t.Fatalf("second request must be shed, got %d", res.StatusCode)
	}
	if o.Metrics.Overloaded.Load() != 1 {
		t.Fatal("shed request not counted")
	}
	// Probes bypass the limiter even at capacity.
	if r2, _ := http.Get(srv.URL + "/livez"); r2.StatusCode != 200 {
		t.Fatal("probes must bypass the limiter")
	}
	close(release)
	wg.Wait()
}

func TestRequestIDAndCORS(t *testing.T) {
	o := opts(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, RequestID(r.Context()))
	}), &snapshot.Holder{})
	srv := httptest.NewServer(Public(o))
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/x", nil)
	req.Header.Set("X-Request-Id", "abc-123")
	req.Header.Set("Origin", "http://localhost:3000")
	res, _ := http.DefaultClient.Do(req)
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(body) != "abc-123" || res.Header.Get("X-Stratum-Request-Id") != "abc-123" {
		t.Fatalf("request id not propagated: %q", body)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "http://localhost:3000" {
		t.Fatal("allowed origin not echoed")
	}

	req, _ = http.NewRequest(http.MethodPost, srv.URL+"/v1/x", nil)
	req.Header.Set("X-Request-Id", "bad id with spaces")
	req.Header.Set("Origin", "https://evil.example")
	res, _ = http.DefaultClient.Do(req)
	res.Body.Close()
	if res.Header.Get("X-Stratum-Request-Id") == "bad id with spaces" {
		t.Fatal("unsafe request id must be replaced")
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("unknown origin must not get CORS headers")
	}
}
