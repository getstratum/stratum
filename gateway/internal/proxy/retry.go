package proxy

import (
	"context"
	"errors"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/getstratum/stratum/gateway/internal/resilience"
)

// breakerOpenError: the provider's breaker is open; no request was sent.
type breakerOpenError struct{ wait time.Duration }

func (e *breakerOpenError) Error() string { return "provider breaker open" }

// sent is what send hands back with a response: the breaker ticket of the
// attempt that produced it, and whether its status counts as a provider
// failure. The breaker has not heard about that attempt yet: the caller
// reports it with outcome once the body has been read, because a provider
// can fail after its headers (a stream that stalls or breaks).
type sent struct {
	ticket resilience.Ticket
	failed bool
}

// send makes the upstream request, retrying while nothing has reached the
// client yet (ADR-0010):
//   - errors connecting (dial, DNS): the request never left, so sending it
//     again cannot run it twice;
//   - 429, 502, 503 and 504 answers: the provider says "not now". A
//     Retry-After longer than what is left of RetryOptions.MaxWait is
//     respected by not retrying: the client gets the answer and decides.
//
// Never retried: timeouts (the time is already spent), a connection that
// broke after the request was written (the provider may have run it, and a
// generation costs money), 500 and other answers (they may come from the
// request itself). Each retry needs a token from the budget, so retries
// stay a bounded share of traffic.
func (h *Handler) send(ctx context.Context, provID string, build func() (*http.Request, error)) (*http.Response, sent, error) {
	if h.Budget != nil {
		h.Budget.Request()
	}
	deadline := time.Now().Add(h.Retry.MaxWait)
	for attempt := 0; ; attempt++ {
		tk := resilience.Ticket{OK: true}
		if h.Breakers != nil {
			if tk = h.Breakers.Allow(provID); !tk.OK {
				h.Metrics.BreakerRejections.Add(1)
				return nil, sent{}, &breakerOpenError{wait: tk.Wait}
			}
		}
		req, err := build()
		if err != nil {
			h.release(provID, tk)
			return nil, sent{}, err
		}
		res, err := h.Client.Do(req)
		failed, retryable, after := classify(res, err)

		final := !retryable || attempt >= h.Retry.Max || ctx.Err() != nil
		wait := after
		if wait == 0 {
			wait = backoff(attempt)
		}
		if !final && time.Now().Add(wait).After(deadline) {
			final = true
		}
		if !final && h.Budget != nil && !h.Budget.TakeRetry() {
			h.Metrics.RetryBudgetExhausted.Add(1)
			final = true
		}
		if final && err == nil {
			return res, sent{ticket: tk, failed: failed}, nil // outcome reported by the caller
		}
		if h.Breakers != nil {
			if ctx.Err() != nil {
				h.Breakers.Release(provID, tk) // the client left: nothing learned
			} else {
				h.Breakers.Record(provID, failed)
			}
		}
		if final {
			return nil, sent{}, err
		}
		if res != nil {
			io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10)) // reuse the connection
			res.Body.Close()
		}
		h.Metrics.UpstreamRetries.Add(1)
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return nil, sent{}, ctx.Err()
		case <-t.C:
		}
	}
}

// outcome reports to the breaker how the response send returned ended:
// broken reports a failure after the headers (a stalled or cut stream),
// clientLeft that the client went away before the end.
func (h *Handler) outcome(provID string, s sent, broken, clientLeft bool) {
	if h.Breakers == nil {
		return
	}
	switch {
	case broken || s.failed:
		h.Breakers.Record(provID, true)
	case clientLeft:
		h.Breakers.Release(provID, s.ticket)
	default:
		h.Breakers.Record(provID, false)
	}
}

func (h *Handler) release(provID string, tk resilience.Ticket) {
	if h.Breakers != nil {
		h.Breakers.Release(provID, tk)
	}
}

// classify says whether an attempt counts as a provider failure (for the
// breaker) and whether it may be retried, and how long the provider asked
// to wait (0: not said).
func classify(res *http.Response, err error) (failed, retryable bool, after time.Duration) {
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return false, false, 0
		}
		if isTimeout(err) {
			return true, false, 0
		}
		return true, notSent(err), 0
	}
	switch res.StatusCode {
	case http.StatusTooManyRequests:
		after, ok := retryAfter(res.Header.Get("Retry-After"))
		return false, ok, after
	case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		after, ok := retryAfter(res.Header.Get("Retry-After"))
		return true, ok, after
	}
	return res.StatusCode >= 500, false, 0
}

// notSent: the error happened while connecting, so the provider never got
// the request.
func notSent(err error) bool {
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return true
	}
	var op *net.OpError
	return errors.As(err, &op) && op.Op == "dial"
}

// retryAfter parses Retry-After (seconds or an HTTP date). ok is false when
// it asks for more than maxProviderWait: then the answer goes back to the
// client instead of being waited out here.
const maxProviderWait = 5 * time.Second

func retryAfter(v string) (time.Duration, bool) {
	if v == "" {
		return 0, true
	}
	if n, err := strconv.Atoi(v); err == nil && n >= 0 {
		d := time.Duration(n) * time.Second
		return d, d <= maxProviderWait
	}
	if t, err := http.ParseTime(v); err == nil {
		d := max(time.Until(t), 0)
		return d, d <= maxProviderWait
	}
	return 0, true
}

// backoff: 250 ms, 500 ms, 1 s, ... with ±50% jitter.
func backoff(attempt int) time.Duration {
	d := 250 * time.Millisecond << min(attempt, 5)
	return time.Duration(float64(d) * (0.5 + rand.Float64()))
}
