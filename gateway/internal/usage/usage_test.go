package usage

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/metrics"
)

// fakeCP records the batches it accepts and answers with the status the
// test sets.
type fakeCP struct {
	mu      sync.Mutex
	status  atomic.Int32
	batches []Batch
	auth    []string
}

func (f *fakeCP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/internal/usage" || r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var b Batch
	body, _ := io.ReadAll(r.Body)
	if err := json.Unmarshal(body, &b); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	f.mu.Lock()
	f.auth = append(f.auth, r.Header.Get("Authorization"))
	st := int(f.status.Load())
	if st == 0 {
		st = http.StatusOK
	}
	if st < 300 {
		f.batches = append(f.batches, b)
	}
	f.mu.Unlock()
	w.WriteHeader(st)
	w.Write([]byte(`{"accepted":1}`))
}

func (f *fakeCP) records() []Record {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Record
	for _, b := range f.batches {
		out = append(out, b.Records...)
	}
	return out
}

func newPusher(t *testing.T, url string, maxBuffer int) (*Pusher, *metrics.Metrics) {
	t.Helper()
	m := metrics.New()
	return &Pusher{
		URL: url, Token: "dp_sync_test", InstanceID: "dp_test", Client: &http.Client{Timeout: 5 * time.Second},
		Interval: time.Hour, MaxBuffer: maxBuffer, Metrics: m,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}, m
}

func rec(i int) Record {
	return Record{ID: NewID(), Time: time.Unix(1_800_000_000+int64(i), 0).UTC(), KeyID: "agent:x", Status: 200, TokensIn: int64(i)}
}

func TestNewIDIsUUIDv4(t *testing.T) {
	re := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	seen := map[string]bool{}
	for range 1000 {
		id := NewID()
		if !re.MatchString(id) {
			t.Fatalf("not a UUID v4: %s", id)
		}
		if seen[id] {
			t.Fatalf("duplicate id %s", id)
		}
		seen[id] = true
	}
}

func TestFlushSendsEverythingInBatches(t *testing.T) {
	cp := &fakeCP{}
	srv := httptest.NewServer(cp)
	defer srv.Close()
	p, m := newPusher(t, srv.URL, 10_000)

	for i := range 1234 {
		p.Add(rec(i))
	}
	p.Flush(context.Background())

	got := cp.records()
	if len(got) != 1234 {
		t.Fatalf("sent %d records, want 1234", len(got))
	}
	for i, r := range got {
		if r.TokensIn != int64(i) {
			t.Fatalf("record %d out of order (tokens_in %d)", i, r.TokensIn)
		}
	}
	if n := len(cp.batches); n != 3 {
		t.Errorf("%d batches, want 3 (500 + 500 + 234)", n)
	}
	for _, b := range cp.batches {
		if b.InstanceID != "dp_test" || len(b.Records) > MaxBatch {
			t.Errorf("bad batch: instance %q, %d records", b.InstanceID, len(b.Records))
		}
	}
	if cp.auth[0] != "Bearer dp_sync_test" {
		t.Errorf("Authorization = %q", cp.auth[0])
	}
	if p.Buffered() != 0 || m.UsageSent.Load() != 1234 || m.UsageBuffered.Load() != 0 {
		t.Errorf("buffered=%d sent=%d gauge=%d", p.Buffered(), m.UsageSent.Load(), m.UsageBuffered.Load())
	}
}

func TestOutageKeepsRecordsAndRetriesThem(t *testing.T) {
	cp := &fakeCP{}
	cp.status.Store(http.StatusServiceUnavailable)
	srv := httptest.NewServer(cp)
	defer srv.Close()
	p, m := newPusher(t, srv.URL, 10_000)

	for i := range 10 {
		p.Add(rec(i))
	}
	p.Flush(context.Background())
	if p.Buffered() != 10 || len(cp.records()) != 0 {
		t.Fatalf("during the outage: buffered=%d sent=%d, want 10 and 0", p.Buffered(), len(cp.records()))
	}
	if m.UsagePushFailures.Load() != 1 || m.UsageDropped.Load() != 0 {
		t.Errorf("failures=%d dropped=%d", m.UsagePushFailures.Load(), m.UsageDropped.Load())
	}

	// Token rotated or gateway disabled: also kept.
	cp.status.Store(http.StatusUnauthorized)
	p.Flush(context.Background())
	if p.Buffered() != 10 {
		t.Fatalf("after a 401: buffered=%d, want 10", p.Buffered())
	}

	cp.status.Store(http.StatusOK)
	p.Flush(context.Background())
	if p.Buffered() != 0 || len(cp.records()) != 10 {
		t.Fatalf("after recovery: buffered=%d sent=%d", p.Buffered(), len(cp.records()))
	}
}

func TestRefusedBatchIsDroppedNotRetriedForever(t *testing.T) {
	cp := &fakeCP{}
	cp.status.Store(http.StatusBadRequest)
	srv := httptest.NewServer(cp)
	defer srv.Close()
	p, m := newPusher(t, srv.URL, 10_000)

	for i := range 3 {
		p.Add(rec(i))
	}
	p.Flush(context.Background())
	if p.Buffered() != 0 || m.UsageDropped.Load() != 3 {
		t.Fatalf("buffered=%d dropped=%d, want 0 and 3", p.Buffered(), m.UsageDropped.Load())
	}
}

func TestFullBufferDropsNewRecords(t *testing.T) {
	p, m := newPusher(t, "http://127.0.0.1:1", 1000)
	for i := range 1005 {
		p.Add(rec(i))
	}
	if p.Buffered() != 1000 || m.UsageDropped.Load() != 5 {
		t.Fatalf("buffered=%d dropped=%d, want 1000 and 5", p.Buffered(), m.UsageDropped.Load())
	}
	p.mu.Lock()
	first, last := p.buf[0].TokensIn, p.buf[len(p.buf)-1].TokensIn
	p.mu.Unlock()
	if first != 0 || last != 999 {
		t.Errorf("kept %d..%d, want the oldest 0..999", first, last)
	}
}

func TestRunSendsAFullBatchWithoutWaitingForTheInterval(t *testing.T) {
	cp := &fakeCP{}
	srv := httptest.NewServer(cp)
	defer srv.Close()
	p, _ := newPusher(t, srv.URL, 10_000) // Interval is an hour

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); p.Run(ctx) }()
	for i := range MaxBatch {
		p.Add(rec(i))
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(cp.records()) < MaxBatch && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	if n := len(cp.records()); n != MaxBatch {
		t.Fatalf("sent %d records, want %d", n, MaxBatch)
	}
}

func TestAddDoesNotBlockWhileASendIsSlow(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	defer close(release)
	p, _ := newPusher(t, srv.URL, 10_000)
	p.Add(rec(0))
	go p.Flush(context.Background())
	time.Sleep(50 * time.Millisecond) // the send is now blocked on the server

	start := time.Now()
	for i := range 1000 {
		p.Add(rec(i + 1))
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("Add blocked for %s while a send was in flight", d)
	}
}

func TestTooLargeBatchIsSentInHalvesNotDropped(t *testing.T) {
	var mu sync.Mutex
	var got []Record
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b Batch
		json.NewDecoder(r.Body).Decode(&b)
		for _, rec := range b.Records {
			if rec.Model == "huge" || len(b.Records) > 3 {
				w.WriteHeader(http.StatusRequestEntityTooLarge)
				return
			}
		}
		mu.Lock()
		got = append(got, b.Records...)
		mu.Unlock()
	}))
	defer srv.Close()
	p, m := newPusher(t, srv.URL, 10_000)
	for i := range 10 {
		r := rec(i)
		if i == 4 {
			r.Model = "huge" // the control plane refuses it even alone
		}
		p.Add(r)
	}
	p.Flush(context.Background())
	if len(got) != 9 || m.UsageDropped.Load() != 1 || p.Buffered() != 0 {
		t.Fatalf("stored %d, dropped %d, left %d: want 9, 1 and 0", len(got), m.UsageDropped.Load(), p.Buffered())
	}
}

func TestClipKeepsWholeCharacters(t *testing.T) {
	if got := Clip("modelo-ñandú", 8); got != "modelo-" {
		t.Errorf("Clip = %q", got)
	}
	if got := Clip("gpt-4o", 100); got != "gpt-4o" {
		t.Errorf("Clip = %q", got)
	}
}
