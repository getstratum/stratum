// Package resilience protects requests from a failing provider (ADR-0010):
// a circuit breaker per provider configuration, so a provider that is down
// fails requests at once instead of holding each one until a timeout, and a
// budget that bounds how many retries the gateway adds on top of the
// traffic it receives.
package resilience

import (
	"sync"
	"time"
)

// BreakerOptions configure every breaker.
type BreakerOptions struct {
	// Failures in a row that open the breaker.
	Threshold int
	// How long it stays open before letting one request through to probe.
	Cooldown time.Duration
}

type state int

const (
	closed state = iota
	open
	halfOpen
)

type breaker struct {
	state    state
	failures int
	openedAt time.Time
	probing  bool
}

// Breakers holds one circuit breaker per key (a provider configuration ID).
// The zero value is not usable; use NewBreakers.
type Breakers struct {
	opts BreakerOptions
	now  func() time.Time

	mu sync.Mutex
	m  map[string]*breaker

	// OnTrip is called (outside the lock) when a breaker opens.
	OnTrip func(key string)
}

func NewBreakers(opts BreakerOptions) *Breakers {
	if opts.Threshold < 1 {
		opts.Threshold = 1
	}
	return &Breakers{opts: opts, now: time.Now, m: map[string]*breaker{}}
}

// Ticket is what Allow hands out: whether the request may go, and whether
// it is the probe of a half-open breaker (only the probe may Release it).
type Ticket struct {
	OK    bool
	Probe bool
	Wait  time.Duration // when refused: until a probe may go
}

// Allow reports whether a request to key may go out now. While a breaker is
// open it refuses, and says how long until it lets a probe through. After
// the cooldown exactly one request is let through; its outcome decides.
func (b *Breakers) Allow(key string) Ticket {
	b.mu.Lock()
	defer b.mu.Unlock()
	br := b.m[key]
	if br == nil {
		return Ticket{OK: true}
	}
	switch br.state {
	case closed:
		return Ticket{OK: true}
	case open:
		wait := br.openedAt.Add(b.opts.Cooldown).Sub(b.now())
		if wait > 0 {
			return Ticket{Wait: wait}
		}
		br.state, br.probing = halfOpen, true
		return Ticket{OK: true, Probe: true}
	default: // half-open: one probe at a time
		if br.probing {
			return Ticket{Wait: time.Second}
		}
		br.probing = true
		return Ticket{OK: true, Probe: true}
	}
}

// Record reports the outcome of a request that Allow let through. Only
// failures of the provider itself count (connection errors, timeouts, 5xx);
// a 4xx, including 429, is about the request or the caller, not the
// provider's health.
func (b *Breakers) Record(key string, failed bool) {
	b.mu.Lock()
	br := b.m[key]
	if br == nil {
		if !failed {
			b.mu.Unlock()
			return
		}
		br = &breaker{}
		b.m[key] = br
	}
	tripped := false
	switch {
	case !failed:
		br.state, br.failures, br.probing = closed, 0, false
	case br.state == halfOpen:
		br.state, br.openedAt, br.probing = open, b.now(), false
		tripped = true
	default:
		br.failures++
		if br.state == closed && br.failures >= b.opts.Threshold {
			br.state, br.openedAt = open, b.now()
			tripped = true
		}
	}
	b.mu.Unlock()
	if tripped && b.OnTrip != nil {
		b.OnTrip(key)
	}
}

// Release ends a request that Allow let through without an outcome about
// the provider (the client went away first). For the probe of a half-open
// breaker, it frees the slot for another probe; for any other ticket it
// does nothing.
func (b *Breakers) Release(key string, t Ticket) {
	if !t.Probe {
		return
	}
	b.mu.Lock()
	if br := b.m[key]; br != nil && br.state == halfOpen {
		br.probing = false
	}
	b.mu.Unlock()
}

// Open returns how many breakers are open or probing.
func (b *Breakers) Open() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, br := range b.m {
		if br.state != closed {
			n++
		}
	}
	return n
}

// Budget is a token bucket that bounds retries to a share of requests: every
// request adds Ratio of a token, a retry takes one. MinPerSecond tokens a
// second are added regardless, so a quiet gateway can still retry.
type Budget struct {
	Ratio        float64
	MinPerSecond float64
	Max          float64

	mu     sync.Mutex
	tokens float64
	last   time.Time
	now    func() time.Time
}

func NewBudget(ratio, minPerSecond, max float64) *Budget {
	return &Budget{Ratio: ratio, MinPerSecond: minPerSecond, Max: max, tokens: max, now: time.Now}
}

func (b *Budget) refill() {
	t := b.now()
	if !b.last.IsZero() {
		b.tokens = min(b.Max, b.tokens+t.Sub(b.last).Seconds()*b.MinPerSecond)
	}
	b.last = t
}

// Request records one incoming request.
func (b *Budget) Request() {
	b.mu.Lock()
	b.refill()
	b.tokens = min(b.Max, b.tokens+b.Ratio)
	b.mu.Unlock()
}

// TakeRetry spends a token for one retry; false when the budget is empty.
func (b *Budget) TakeRetry() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refill()
	if b.tokens < 1-1e-9 { // ten requests at 0.1 add up to 0.999…
		return false
	}
	b.tokens = max(0, b.tokens-1)
	return true
}
