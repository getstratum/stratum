package resilience

import (
	"testing"
	"time"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }

func TestBreakerOpensAfterFailuresInARowAndProbesAfterTheCooldown(t *testing.T) {
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	trips := 0
	b := NewBreakers(BreakerOptions{Threshold: 3, Cooldown: 30 * time.Second})
	b.now = c.now
	b.OnTrip = func(string) { trips++ }

	// A success in between resets the count.
	for _, failed := range []bool{true, true, false, true, true} {
		if !b.Allow("p").OK {
			t.Fatal("refused while closed")
		}
		b.Record("p", failed)
	}
	if !b.Allow("p").OK {
		t.Fatal("two failures in a row must not open it")
	}
	b.Record("p", true) // third in a row
	if trips != 1 || b.Open() != 1 {
		t.Fatalf("trips=%d open=%d", trips, b.Open())
	}

	tk := b.Allow("p")
	if tk.OK || tk.Wait != 30*time.Second {
		t.Fatalf("open: %+v", tk)
	}
	if !b.Allow("other").OK {
		t.Fatal("breakers are per key")
	}

	c.advance(30 * time.Second)
	if tk := b.Allow("p"); !tk.OK || !tk.Probe {
		t.Fatalf("after the cooldown one probe goes through: %+v", tk)
	}
	if b.Allow("p").OK {
		t.Fatal("only one probe at a time")
	}
	b.Record("p", true) // the probe failed: open again
	if b.Allow("p").OK || trips != 2 {
		t.Fatalf("a failed probe reopens: trips=%d", trips)
	}

	c.advance(30 * time.Second)
	b.Allow("p")
	b.Record("p", false) // the probe succeeded
	if !b.Allow("p").OK || b.Open() != 0 {
		t.Fatal("a good probe closes it")
	}
}

func TestReleaseFreesTheProbe(t *testing.T) {
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	b := NewBreakers(BreakerOptions{Threshold: 1, Cooldown: time.Second})
	b.now = c.now
	old := b.Allow("p") // a request from while it was closed
	b.Record("p", true)
	c.advance(time.Second)
	probe := b.Allow("p")
	if !probe.OK || !probe.Probe {
		t.Fatal("probe")
	}
	b.Release("p", old) // the old request's client left: the probe keeps its slot
	if b.Allow("p").OK {
		t.Fatal("releasing another ticket must not free the probe's slot")
	}
	b.Release("p", probe) // the probe's client left before an answer
	if !b.Allow("p").OK {
		t.Fatal("after the probe's release another probe may go")
	}
}

func TestBudgetBoundsRetriesToAShareOfRequests(t *testing.T) {
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	b := NewBudget(0.2, 0, 10)
	b.now = c.now
	b.tokens = 0

	for range 10 {
		b.Request()
	}
	got := 0
	for b.TakeRetry() {
		got++
	}
	if got != 2 {
		t.Fatalf("10 requests at 20%% allow %d retries, want 2", got)
	}

	// The minimum refills with time, up to the maximum.
	b2 := NewBudget(0, 1, 3)
	b2.now = c.now
	b2.tokens = 0
	b2.TakeRetry() // sets the clock
	c.advance(time.Hour)
	n := 0
	for b2.TakeRetry() {
		n++
	}
	if n != 3 {
		t.Fatalf("refill capped at the maximum: %d", n)
	}
}
