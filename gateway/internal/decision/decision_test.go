package decision

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// service is a fake decision service: it answers /v1/check with answer
// (after delay) and keeps what /v1/report gets.
type service struct {
	mu      sync.Mutex
	answer  string
	status  int
	delay   time.Duration
	checks  []Request
	reports []Report
	auth    string
	tp      string // the traceparent of the last call
	refuse  bool   // /v1/report answers 503
}

func (s *service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.auth, s.tp = r.Header.Get("Authorization"), r.Header.Get("Traceparent")
	s.mu.Unlock()
	switch r.URL.Path {
	case "/v1/check":
		var req Request
		json.NewDecoder(r.Body).Decode(&req)
		s.mu.Lock()
		s.checks = append(s.checks, req)
		a, st, d := s.answer, s.status, s.delay
		s.mu.Unlock()
		if d > 0 {
			select {
			case <-time.After(d):
			case <-r.Context().Done():
				return
			}
		}
		if st == 0 {
			st = 200
		}
		w.WriteHeader(st)
		io.WriteString(w, a)
	case "/v1/report":
		var b struct {
			V       int
			Reports []Report
		}
		json.NewDecoder(r.Body).Decode(&b)
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.refuse {
			w.WriteHeader(503)
			return
		}
		s.reports = append(s.reports, b.Reports...)
	default:
		http.NotFound(w, r)
	}
}

func start(t *testing.T, s *service) string {
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return srv.URL + "/" // a trailing slash is fine
}

const allow = `{"decision":"allow"}`

func TestAllowCarriesTheRequestAndTheToken(t *testing.T) {
	s := &service{answer: `{"decision":"allow","labels":["loop_watch","NOT OK"],"headers":{"x-stratum-task-budget":"0.42","Set-Cookie":"no"}}`}
	c := New(Options{URLs: []string{start(t, s)}, Token: "tok"})
	d := c.Check(context.Background(), Request{KeyID: "agent:a1", TeamID: "t1", Task: "ticket-42", Provider: "openai", Model: "gpt-4o",
		ContentSHA256: "abc", ContentBytes: 10})
	if !d.Allow || d.Skipped {
		t.Fatalf("decision = %+v", d)
	}
	if len(d.Labels) != 1 || d.Labels[0] != "loop_watch" {
		t.Errorf("labels = %v (invalid ones dropped)", d.Labels)
	}
	if d.Headers["X-Stratum-Task-Budget"] != "0.42" || d.Headers["Set-Cookie"] != "" {
		t.Errorf("headers = %v (only X-Stratum-* and Retry-After)", d.Headers)
	}
	got := s.checks[0]
	if got.V != 1 || got.KeyID != "agent:a1" || got.Task != "ticket-42" || got.ContentSHA256 != "abc" {
		t.Errorf("request = %+v", got)
	}
	if s.auth != "Bearer tok" || s.tp != "" {
		t.Errorf("auth = %q, traceparent = %q", s.auth, s.tp)
	}
	const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	c.Check(context.Background(), Request{Traceparent: tp})
	if s.tp != tp || strings.Contains(string(mustJSON(t, s.checks[1])), "4bf92f") {
		t.Errorf("traceparent %q; in the body: %s", s.tp, mustJSON(t, s.checks[1]))
	}
	if c.Counters.Allowed.Load() != 2 {
		t.Error("allowed not counted")
	}
}

func TestFirstDenyInOrderWins(t *testing.T) {
	a := &service{answer: allow}
	b := &service{answer: `{"decision":"deny","status":429,"code":"task_budget_exceeded","message":"la tarea gastó su presupuesto","headers":{"Retry-After":"60"}}`}
	c2 := &service{answer: `{"decision":"deny","status":200,"code":"Bad Code!","message":"x"}`}
	c := New(Options{URLs: []string{start(t, a), start(t, b), start(t, c2)}})
	d := c.Check(context.Background(), Request{})
	if d.Allow || d.Status != 429 || d.Code != "task_budget_exceeded" || d.Headers["Retry-After"] != "60" {
		t.Fatalf("decision = %+v", d)
	}
	if !strings.HasPrefix(d.By, "http://") {
		t.Errorf("by = %q", d.By)
	}
	// Bounds on what a service says.
	c = New(Options{URLs: []string{start(t, c2)}})
	d = c.Check(context.Background(), Request{})
	if d.Status != 403 || d.Code != "denied_by_decision_service" {
		t.Errorf("an odd deny = %+v", d)
	}
}

func TestAServiceThatDoesNotAnswerFailsOpenOrClosed(t *testing.T) {
	slow := &service{answer: allow, delay: time.Second}
	broken := &service{answer: `{"decision":"maybe"}`}
	down := &service{answer: allow, status: 500}
	for _, s := range []*service{slow, broken, down} {
		url := start(t, s)
		open := New(Options{URLs: []string{url}, Timeout: 50 * time.Millisecond})
		started := time.Now()
		d := open.Check(context.Background(), Request{})
		if !d.Allow || !d.Skipped {
			t.Errorf("fail open: %+v", d)
		}
		if time.Since(started) > 500*time.Millisecond {
			t.Error("the timeout is not respected")
		}
		if open.Counters.Errors.Load() != 1 || open.Counters.Skipped.Load() != 1 {
			t.Error("not counted")
		}
		closed := New(Options{URLs: []string{url}, Timeout: 50 * time.Millisecond, FailClosed: true})
		if d := closed.Check(context.Background(), Request{}); d.Allow || d.Status != 503 || d.Code != "decision_unavailable" {
			t.Errorf("fail closed: %+v", d)
		}
	}
	// A deny still wins over a service that did not answer.
	deny := &service{answer: `{"decision":"deny","status":403,"code":"agent_paused","message":"pausado"}`}
	c := New(Options{URLs: []string{start(t, slow), start(t, deny)}, Timeout: 50 * time.Millisecond})
	if d := c.Check(context.Background(), Request{}); d.Allow || d.Code != "agent_paused" {
		t.Errorf("deny with one down: %+v", d)
	}
}

func TestReportsGoInBatchesAndWaitWhileNobodyTakesThem(t *testing.T) {
	s := &service{answer: allow, refuse: true}
	c := New(Options{URLs: []string{start(t, s)}, ReportBatch: 2, ReportBuffer: 3})
	for i := range 4 {
		c.Report(Report{KeyID: "k", Status: 200 + i})
	}
	if c.Counters.ReportsDropped.Load() != 1 || c.Pending() != 3 {
		t.Fatalf("dropped %d, pending %d: the buffer holds 3", c.Counters.ReportsDropped.Load(), c.Pending())
	}
	c.Flush(context.Background())
	if c.Pending() != 3 {
		t.Fatalf("pending %d: refused reports stay queued", c.Pending())
	}
	s.mu.Lock()
	s.refuse = false
	s.mu.Unlock()
	c.Flush(context.Background())
	if c.Pending() != 0 || len(s.reports) != 3 || c.Counters.ReportsSent.Load() != 3 {
		t.Fatalf("pending %d, got %d, sent %d", c.Pending(), len(s.reports), c.Counters.ReportsSent.Load())
	}
	if s.reports[0].Status != 200 || s.reports[2].Status != 202 {
		t.Errorf("order: %+v", s.reports)
	}
}

func TestRunFlushesOnStop(t *testing.T) {
	s := &service{answer: allow}
	c := New(Options{URLs: []string{start(t, s)}, ReportInterval: time.Hour})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { c.Run(ctx); close(done) }()
	c.Report(Report{KeyID: "k"})
	cancel()
	<-done
	if len(s.reports) != 1 {
		t.Fatalf("got %d reports", len(s.reports))
	}
}

func TestClipKeepsRunesWhole(t *testing.T) {
	if got := clip("añb", 2); got != "a" {
		t.Errorf("clip = %q", got)
	}
	if got := printable("a\nb\x00c"); got != "abc" {
		t.Errorf("printable = %q", got)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
