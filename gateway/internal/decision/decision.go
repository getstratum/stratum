// Package decision asks external decision services whether a request may go
// to the provider, and tells them how each one ended (ADR-0014).
//
// A decision service is any HTTP service, usually beside the gateway in the
// same network, that implements two endpoints:
//
//	POST {url}/v1/check   one request, before it goes to the provider:
//	                      allow (optionally adding labels and response
//	                      headers) or deny (status, code, message)
//	POST {url}/v1/report  how checked requests ended: status, tokens, time;
//	                      sent in batches, off the request path
//
// The gateway sends metadata only: who (key, team, person), the task the
// application named, the route, and a SHA-256 of the request's content, so
// a service can tell a repeated request without seeing it. Several services
// are asked at once; the first one that denies, in the configured order,
// decides. A service that does not answer in time is skipped (fail open,
// the default) or refuses the request (fail closed).
package decision

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Version of the protocol, in every body the gateway sends.
const Version = 1

// Request is what /v1/check gets.
type Request struct {
	V             int      `json:"v"`
	RequestID     string   `json:"request_id,omitempty"`
	Time          string   `json:"time"`
	KeyID         string   `json:"key_id"`
	KeyLabel      string   `json:"key_label,omitempty"`
	TeamID        string   `json:"team_id"`
	UserID        string   `json:"user_id,omitempty"`
	Task          string   `json:"task,omitempty"`
	Provider      string   `json:"provider"`
	Model         string   `json:"model"`
	Operation     string   `json:"operation,omitempty"`
	Stream        bool     `json:"stream"`
	Labels        []string `json:"labels,omitempty"`
	ContentSHA256 string   `json:"content_sha256,omitempty"`
	ContentBytes  int      `json:"content_bytes"`
}

// Decision is the combined answer of every service.
type Decision struct {
	Allow   bool
	Status  int    // when denied
	Code    string // when denied
	Message string // when denied
	By      string // the service that denied (its URL)
	Labels  []string
	Headers map[string]string
	// Skipped: a service did not answer and the gateway went on (fail open).
	Skipped bool
}

// Report is one checked request, as it ended, for /v1/report.
type Report struct {
	RequestID     string `json:"request_id,omitempty"`
	Time          string `json:"time"`
	KeyID         string `json:"key_id"`
	TeamID        string `json:"team_id"`
	UserID        string `json:"user_id,omitempty"`
	Task          string `json:"task,omitempty"`
	Provider      string `json:"provider"`
	Model         string `json:"model"`
	ContentSHA256 string `json:"content_sha256,omitempty"`
	Status        int    `json:"status"`
	Reason        string `json:"reason"`
	TokensIn      int64  `json:"tokens_in"`
	TokensOut     int64  `json:"tokens_out"`
	DurationMs    int64  `json:"duration_ms"`
	UpstreamMs    int64  `json:"upstream_ms"`
}

// Options configure a Client.
type Options struct {
	URLs       []string
	Token      string        // sent as "Authorization: Bearer"; empty: none
	Timeout    time.Duration // per check, all services at once
	FailClosed bool
	HTTP       *http.Client
	Log        *slog.Logger
	// Reports kept while the services do not take them; past it they are dropped.
	ReportBuffer int
	// How often reports are sent, and how many at most in one batch.
	ReportInterval time.Duration
	ReportBatch    int
}

// Counters, read by the gateway's /metrics.
type Counters struct {
	Allowed        atomic.Int64
	Denied         atomic.Int64
	Errors         atomic.Int64 // a service that did not answer, or answered wrong
	Skipped        atomic.Int64 // requests let through without every answer (fail open)
	ReportsSent    atomic.Int64
	ReportsDropped atomic.Int64
}

type Client struct {
	opts     Options
	Counters Counters

	mu      sync.Mutex
	pending []Report
}

func New(o Options) *Client {
	if o.Timeout <= 0 {
		o.Timeout = 200 * time.Millisecond
	}
	if o.HTTP == nil {
		o.HTTP = &http.Client{}
	}
	if o.Log == nil {
		o.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if o.ReportBuffer <= 0 {
		o.ReportBuffer = 10_000
	}
	if o.ReportInterval <= 0 {
		o.ReportInterval = time.Second
	}
	if o.ReportBatch <= 0 {
		o.ReportBatch = 500
	}
	for i, u := range o.URLs {
		o.URLs[i] = strings.TrimRight(u, "/")
	}
	return &Client{opts: o}
}

// answer is what a service may say. Anything else in it is ignored.
type answer struct {
	Decision string            `json:"decision"`
	Status   int               `json:"status"`
	Code     string            `json:"code"`
	Message  string            `json:"message"`
	Labels   []string          `json:"labels"`
	Headers  map[string]string `json:"headers"`
}

var errBadAnswer = errors.New("not a decision")

// Check asks every service at once and combines their answers.
func (c *Client) Check(ctx context.Context, req Request) Decision {
	req.V = Version
	body, _ := json.Marshal(req)
	ctx, cancel := context.WithTimeout(ctx, c.opts.Timeout)
	defer cancel()

	answers := make([]answer, len(c.opts.URLs))
	errs := make([]error, len(c.opts.URLs))
	var wg sync.WaitGroup
	for i, u := range c.opts.URLs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			answers[i], errs[i] = c.ask(ctx, u, body)
		}()
	}
	wg.Wait()

	out := Decision{Allow: true}
	failed := false
	for i, a := range answers {
		if errs[i] != nil {
			failed = true
			c.Counters.Errors.Add(1)
			c.opts.Log.Warn("decision service did not answer", "url", c.opts.URLs[i], "error", errs[i])
			continue
		}
		if a.Decision == "deny" {
			c.Counters.Denied.Add(1)
			return Decision{Status: denyStatus(a.Status), Code: denyCode(a.Code), Message: clip(printable(a.Message), 300),
				By: c.opts.URLs[i], Headers: headersOf(a.Headers)}
		}
		out.Labels = append(out.Labels, labelsOf(a.Labels)...)
		for k, v := range headersOf(a.Headers) {
			if out.Headers == nil {
				out.Headers = map[string]string{}
			}
			if _, set := out.Headers[k]; !set {
				out.Headers[k] = v
			}
		}
	}
	if failed {
		if c.opts.FailClosed {
			c.Counters.Denied.Add(1)
			return Decision{Status: http.StatusServiceUnavailable, Code: "decision_unavailable",
				Message: "a decision service did not answer; the request was not sent"}
		}
		c.Counters.Skipped.Add(1)
		out.Skipped = true
	}
	c.Counters.Allowed.Add(1)
	return out
}

func (c *Client) ask(ctx context.Context, base string, body []byte) (answer, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/check", bytes.NewReader(body))
	if err != nil {
		return answer{}, err
	}
	c.headers(req)
	res, err := c.opts.HTTP.Do(req)
	if err != nil {
		return answer{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
		return answer{}, fmt.Errorf("status %d", res.StatusCode)
	}
	var a answer
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&a); err != nil {
		return answer{}, err
	}
	if a.Decision != "allow" && a.Decision != "deny" {
		return answer{}, errBadAnswer
	}
	return a, nil
}

func (c *Client) headers(r *http.Request) {
	r.Header.Set("Content-Type", "application/json")
	if c.opts.Token != "" {
		r.Header.Set("Authorization", "Bearer "+c.opts.Token)
	}
}

// Report queues one record; never blocks. Past the buffer it is dropped.
func (c *Client) Report(r Report) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.pending) >= c.opts.ReportBuffer {
		c.Counters.ReportsDropped.Add(1)
		return
	}
	c.pending = append(c.pending, r)
}

// Run sends the queued reports every ReportInterval until ctx ends, then
// once more.
func (c *Client) Run(ctx context.Context) {
	t := time.NewTicker(c.opts.ReportInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			flush, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			c.Flush(flush)
			cancel()
			return
		case <-t.C:
			c.Flush(ctx)
		}
	}
}

// Flush sends what is queued, in batches, to every service. A batch every
// service refuses goes back to the queue (while it fits); one that at least
// one service took is done: services are told, not asked, and a lost report
// costs one request's count.
func (c *Client) Flush(ctx context.Context) {
	for {
		c.mu.Lock()
		n := min(len(c.pending), c.opts.ReportBatch)
		batch := append([]Report(nil), c.pending[:n]...)
		c.pending = c.pending[n:]
		c.mu.Unlock()
		if n == 0 {
			return
		}
		body, _ := json.Marshal(struct {
			V       int      `json:"v"`
			Reports []Report `json:"reports"`
		}{Version, batch})
		taken := false
		for _, u := range c.opts.URLs {
			if err := c.post(ctx, u+"/v1/report", body); err != nil {
				c.opts.Log.Warn("decision service did not take reports", "url", u, "error", err)
				continue
			}
			taken = true
		}
		if !taken {
			c.mu.Lock()
			room := c.opts.ReportBuffer - len(c.pending)
			if room >= len(batch) {
				c.pending = append(batch, c.pending...)
			} else {
				c.Counters.ReportsDropped.Add(int64(len(batch)))
			}
			c.mu.Unlock()
			return
		}
		c.Counters.ReportsSent.Add(int64(len(batch)))
	}
}

func (c *Client) post(ctx context.Context, url string, body []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	c.headers(req)
	res, err := c.opts.HTTP.Do(req)
	if err != nil {
		return err
	}
	io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	res.Body.Close()
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("status %d", res.StatusCode)
	}
	return nil
}

// Pending is how many reports wait to be sent.
func (c *Client) Pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.pending)
}

// ── What a service may say, kept within bounds ─────────────────────────

var (
	codeRE   = regexp.MustCompile(`^[a-z][a-z0-9_]{0,49}$`)
	labelRE  = regexp.MustCompile(`^[a-z0-9_]{1,40}$`)
	headerRE = regexp.MustCompile(`^X-Stratum-[A-Za-z0-9-]{1,48}$`)
)

func denyStatus(s int) int {
	if s >= 400 && s <= 599 {
		return s
	}
	return http.StatusForbidden
}

func denyCode(c string) string {
	if codeRE.MatchString(c) {
		return c
	}
	return "denied_by_decision_service"
}

func labelsOf(ls []string) []string {
	var out []string
	for _, l := range ls {
		if labelRE.MatchString(l) && len(out) < 8 {
			out = append(out, l)
		}
	}
	return out
}

// headersOf keeps X-Stratum-* headers and Retry-After, at most 8, printable.
func headersOf(h map[string]string) map[string]string {
	var out map[string]string
	for k, v := range h {
		name := http.CanonicalHeaderKey(k)
		if name != "Retry-After" && !headerRE.MatchString(name) {
			continue
		}
		v = clip(printable(v), 200)
		if v == "" || len(out) >= 8 {
			continue
		}
		if out == nil {
			out = map[string]string{}
		}
		out[name] = v
	}
	return out
}

func printable(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && (s[n]&0xC0) == 0x80 { // not in the middle of a UTF-8 rune
		n--
	}
	return s[:n]
}
