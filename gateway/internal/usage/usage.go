// Package usage reports what each request consumed to the control plane, so
// the console can show usage, spend and logs (ADR-0009).
//
// It is never on the request path: the proxy hands a Record to Add, which
// only appends to an in-memory buffer, and a background loop sends the
// buffer in batches. If the control plane is down the buffer grows up to a
// bound and the records wait; past that bound new records are dropped and
// counted. Each record carries its own ID, so a batch the control plane
// stored but did not acknowledge can be sent again without counting twice.
//
// The buffer lives in memory: records still buffered when the process dies
// without a graceful shutdown are lost. A graceful shutdown sends them.
package usage

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/getstratum/stratum/gateway/internal/metrics"
)

// Record is one request, as the control plane stores it. It holds metadata
// only: never prompts, completions or credentials.
type Record struct {
	ID           string    `json:"id"` // UUID v4, the idempotency key
	Time         time.Time `json:"ts"`
	RequestID    string    `json:"request_id,omitempty"`
	KeyID        string    `json:"key_id"`
	TeamID       string    `json:"team_id,omitempty"`
	Provider     string    `json:"provider,omitempty"`
	Model        string    `json:"model,omitempty"`
	Status       int       `json:"status"`
	Reason       string    `json:"reason,omitempty"`
	Stream       bool      `json:"stream"`
	DurationMs   int64     `json:"duration_ms"`
	UpstreamMs   int64     `json:"upstream_ms"`
	TokensIn     int64     `json:"tokens_in"`
	TokensOut    int64     `json:"tokens_out"`
	ContentFlags []string  `json:"content_flags,omitempty"`
}

// Batch is the body of POST /api/internal/usage (api/usage/v1).
type Batch struct {
	InstanceID string   `json:"instance_id"`
	Records    []Record `json:"records"`
}

// NewID returns a random UUID v4.
func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand does not fail on supported platforms
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

const (
	// MaxBatch is the most records sent in one request; the control plane
	// refuses larger batches.
	MaxBatch = 500
	maxBody  = 8 << 10
)

// Pusher buffers records and sends them to {URL}/api/internal/usage,
// authenticated with the gateway's sync token.
type Pusher struct {
	URL        string
	Token      string
	InstanceID string
	UserAgent  string
	Client     *http.Client
	Interval   time.Duration // between sends when the buffer is below MaxBatch
	MaxBuffer  int           // records kept while the control plane is unreachable
	Metrics    *metrics.Metrics
	Log        *slog.Logger

	mu     sync.Mutex
	buf    []Record
	notify chan struct{}
	once   sync.Once
}

func (p *Pusher) init() {
	p.once.Do(func() { p.notify = make(chan struct{}, 1) })
}

// Add buffers a record. It never blocks on the network. When the buffer is
// full the record is dropped (the oldest ones are kept: they are the ones a
// control plane that comes back will ask about first) and counted.
func (p *Pusher) Add(r Record) {
	p.init()
	p.mu.Lock()
	if len(p.buf) >= p.MaxBuffer {
		p.mu.Unlock()
		p.Metrics.UsageDropped.Add(1)
		return
	}
	p.buf = append(p.buf, r)
	n := len(p.buf)
	p.mu.Unlock()
	p.Metrics.UsageBuffered.Store(int64(n))
	if n >= MaxBatch {
		select {
		case p.notify <- struct{}{}:
		default:
		}
	}
}

// Buffered returns how many records are waiting to be sent.
func (p *Pusher) Buffered() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.buf)
}

// Run sends batches until ctx is cancelled: every Interval, or as soon as a
// full batch is waiting. After a failure it backs off up to 2 minutes.
func (p *Pusher) Run(ctx context.Context) {
	p.init()
	failures := 0
	for {
		wait := p.Interval
		if failures > 0 {
			wait = min(time.Second<<min(failures-1, 7), 2*time.Minute)
		}
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		case <-p.notify:
			t.Stop()
			if failures > 0 {
				continue // a full buffer does not shorten the backoff
			}
		}
		if err := p.sendAll(ctx); err != nil {
			failures++
			if ctx.Err() == nil {
				p.Log.Warn("could not report usage to the control plane; keeping it buffered",
					"err", err, "buffered", p.Buffered(), "consecutive_failures", failures)
			}
		} else {
			failures = 0
		}
	}
}

// Flush sends everything buffered, for a graceful shutdown. It gives up when
// ctx ends and reports how many records were left.
func (p *Pusher) Flush(ctx context.Context) {
	if err := p.sendAll(ctx); err != nil {
		p.Log.Warn("usage not reported before shutdown", "err", err, "lost", p.Buffered())
	}
}

// sendAll sends batches until the buffer is empty or a send fails.
func (p *Pusher) sendAll(ctx context.Context) error {
	size := MaxBatch
	for {
		p.mu.Lock()
		n := min(len(p.buf), size)
		batch := append([]Record(nil), p.buf[:n]...)
		p.mu.Unlock()
		if n == 0 {
			return nil
		}

		err := p.send(ctx, batch)
		var bad *rejectedError
		switch {
		case err == nil:
			p.Metrics.UsageSent.Add(int64(n))
		case errors.As(err, &bad) && bad.status == http.StatusRequestEntityTooLarge && n > 1:
			// Too large as a whole: send it in halves, so one oversized
			// record cannot take its neighbours down with it.
			size = max(1, n/2)
			continue
		case errors.As(err, &bad):
			// The control plane will never accept this batch as it is;
			// keeping it would block every record behind it.
			p.Metrics.UsageDropped.Add(int64(n))
			p.Log.Error("control plane refused a usage batch; dropping it", "records", n, "err", err)
		default:
			p.Metrics.UsagePushFailures.Add(1)
			return err
		}
		// Only the sender removes from the front, so these are the records sent.
		p.mu.Lock()
		p.buf = p.buf[n:]
		if len(p.buf) == 0 {
			p.buf = nil // release the backing array after a long outage
		}
		left := len(p.buf)
		p.mu.Unlock()
		p.Metrics.UsageBuffered.Store(int64(left))
		size = MaxBatch
	}
}

// Clip cuts s to at most n bytes without splitting a UTF-8 character. The
// control plane stores provider names up to 50 bytes and models up to 100;
// longer values come from a client and are clipped before they are kept.
func Clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

type rejectedError struct {
	status int
	body   string
}

func (e *rejectedError) Error() string {
	return fmt.Sprintf("control plane answered %d: %s", e.status, e.body)
}

func (p *Pusher) send(ctx context.Context, records []Record) error {
	body, err := json.Marshal(Batch{InstanceID: p.InstanceID, Records: records})
	if err != nil {
		return &rejectedError{status: 0, body: err.Error()}
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.URL+"/api/internal/usage", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+p.Token)
	req.Header.Set("Content-Type", "application/json")
	if p.UserAgent != "" {
		req.Header.Set("User-Agent", p.UserAgent)
	}
	res, err := p.Client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	snippet, _ := io.ReadAll(io.LimitReader(res.Body, maxBody))
	switch {
	case res.StatusCode >= 200 && res.StatusCode < 300:
		return nil
	case res.StatusCode == http.StatusBadRequest || res.StatusCode == http.StatusRequestEntityTooLarge ||
		res.StatusCode == http.StatusUnprocessableEntity:
		return &rejectedError{status: res.StatusCode, body: string(snippet)}
	default:
		// 401/403 (token rotated, gateway disabled), 404 (older control
		// plane), 429, 5xx: keep the records and try again later.
		return fmt.Errorf("control plane answered %d: %s", res.StatusCode, bytes.TrimSpace(snippet))
	}
}
