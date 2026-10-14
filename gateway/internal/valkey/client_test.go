package valkey

import (
	"bufio"
	"context"
	"errors"
	"net"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseURL(t *testing.T) {
	cases := []struct {
		in             string
		addr, user, pw string
		db             int
		tls            bool
		bad            bool
	}{
		{in: "redis://localhost", addr: "localhost:6379"},
		{in: "valkey://v:6380/2", addr: "v:6380", db: 2},
		{in: "rediss://:s3cret@cache.example.com", addr: "cache.example.com:6379", pw: "s3cret", tls: true},
		{in: "valkeys://app:pw@h:6390/0", addr: "h:6390", user: "app", pw: "pw", tls: true},
		{in: "redis://onlypassword@h", addr: "h:6379", pw: "onlypassword"},
		{in: "http://h", bad: true},
		{in: "redis:///0", bad: true},
		{in: "redis://h/x", bad: true},
	}
	for _, c := range cases {
		o, err := ParseURL(c.in)
		if c.bad {
			if err == nil {
				t.Errorf("%s: expected an error", c.in)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.in, err)
			continue
		}
		if o.Addr != c.addr || o.Username != c.user || o.Password != c.pw || o.DB != c.db || (o.TLS != nil) != c.tls {
			t.Errorf("%s: got %+v", c.in, o)
		}
	}
}

func TestParseURLDoesNotLeakPassword(t *testing.T) {
	_, err := ParseURL("redis://user:hunter2@[::1")
	if err == nil || strings.Contains(err.Error(), "hunter2") {
		t.Fatalf("error must not contain the password: %v", err)
	}
}

// fakeServer answers a few commands and records what it receives.
type fakeServer struct {
	ln       net.Listener
	conns    atomic.Int64
	commands chan []string
	dropNext atomic.Bool // close the connection instead of answering
}

func newFakeServer(t *testing.T) *fakeServer {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &fakeServer{ln: ln, commands: make(chan []string, 64)}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			s.conns.Add(1)
			go s.serve(c)
		}
	}()
	return s
}

func (s *fakeServer) serve(c net.Conn) {
	defer c.Close()
	r := bufio.NewReader(c)
	for {
		v, err := readReply(r, 0)
		if err != nil {
			return
		}
		raw := v.([]any)
		args := make([]string, len(raw))
		for i, a := range raw {
			args[i] = a.(string)
		}
		s.commands <- args
		if s.dropNext.CompareAndSwap(true, false) {
			return
		}
		var out string
		switch strings.ToUpper(args[0]) {
		case "PING", "AUTH", "SELECT":
			out = "+OK\r\n"
		case "INCRBY":
			out = ":" + args[2] + "\r\n"
		case "GET":
			out = "$-1\r\n"
		case "MIXED":
			out = "*4\r\n:1\r\n$5\r\nhello\r\n$-1\r\n*1\r\n+nested\r\n"
		default:
			out = "-ERR unknown command\r\n"
		}
		c.Write([]byte(out))
	}
}

func (s *fakeServer) next(t *testing.T) []string {
	t.Helper()
	select {
	case c := <-s.commands:
		return c
	case <-time.After(2 * time.Second):
		t.Fatal("no command received")
		return nil
	}
}

func TestClientAuthSelectAndReplies(t *testing.T) {
	srv := newFakeServer(t)
	c := New(Options{Addr: srv.ln.Addr().String(), Username: "app", Password: "pw", DB: 3})
	defer c.Close()
	ctx := context.Background()

	v, err := c.Do(ctx, "INCRBY", "k", "42")
	if err != nil || v != int64(42) {
		t.Fatalf("INCRBY: %v %v", v, err)
	}
	if got := srv.next(t); strings.Join(got, " ") != "AUTH app pw" {
		t.Fatalf("first command %v", got)
	}
	if got := srv.next(t); strings.Join(got, " ") != "SELECT 3" {
		t.Fatalf("second command %v", got)
	}
	srv.next(t)

	v, err = c.Do(ctx, "MIXED")
	if err != nil {
		t.Fatal(err)
	}
	arr := v.([]any)
	if arr[0] != int64(1) || arr[1] != "hello" || arr[2] != nil || arr[3].([]any)[0] != "nested" {
		t.Fatalf("MIXED: %#v", arr)
	}
	srv.next(t)

	if v, err := c.Do(ctx, "GET", "missing"); err != nil || v != nil {
		t.Fatalf("GET missing: %v %v", v, err)
	}
	srv.next(t)

	_, err = c.Do(ctx, "NOPE")
	var se Error
	if !errors.As(err, &se) || !strings.HasPrefix(string(se), "ERR") {
		t.Fatalf("server error: %v", err)
	}
	srv.next(t)
	if _, err := c.Do(ctx, "PING"); err != nil {
		t.Fatalf("connection must survive a server error: %v", err)
	}
	srv.next(t)
	if n := srv.conns.Load(); n != 1 {
		t.Fatalf("%d connections, want 1", n)
	}
}

func TestClientReconnectsAfterDrop(t *testing.T) {
	srv := newFakeServer(t)
	c := New(Options{Addr: srv.ln.Addr().String(), IOTimeout: time.Second})
	defer c.Close()
	ctx := context.Background()

	if _, err := c.Do(ctx, "PING"); err != nil {
		t.Fatal(err)
	}
	srv.next(t)
	srv.dropNext.Store(true)
	if _, err := c.Do(ctx, "PING"); err == nil {
		t.Fatal("dropped connection must surface as an error")
	}
	srv.next(t)
	if _, err := c.Do(ctx, "PING"); err != nil {
		t.Fatalf("next call must reconnect: %v", err)
	}
	if n := srv.conns.Load(); n != 2 {
		t.Fatalf("%d connections, want 2", n)
	}
}

func TestClientTimesOut(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err == nil {
			defer c.Close()
			time.Sleep(2 * time.Second) // never answers
		}
	}()
	c := New(Options{Addr: ln.Addr().String(), IOTimeout: 100 * time.Millisecond})
	start := time.Now()
	if _, err := c.Do(context.Background(), "PING"); err == nil {
		t.Fatal("expected a timeout")
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("timeout took %v", d)
	}
}

func TestReadReplyRejectsGarbage(t *testing.T) {
	for _, in := range []string{"?x\r\n", ":abc\r\n", "$999999999999\r\n", "+no-crlf\n", "$3\r\nabcd\r\n"} {
		if _, err := readReply(bufio.NewReader(strings.NewReader(in)), 0); err == nil {
			t.Errorf("%q: expected an error", in)
		}
	}
}

func TestAgainstValkey(t *testing.T) {
	raw := os.Getenv("STRATUM_TEST_VALKEY_URL")
	if raw == "" {
		t.Skip("STRATUM_TEST_VALKEY_URL not set")
	}
	o, err := ParseURL(raw)
	if err != nil {
		t.Fatal(err)
	}
	c := New(o)
	defer c.Close()
	ctx := context.Background()
	if v, err := c.Do(ctx, "PING"); err != nil || v != "PONG" {
		t.Fatalf("PING: %v %v", v, err)
	}
	key := "stratum-test-client-" + time.Now().Format("150405.000000")
	defer c.Do(ctx, "DEL", key)
	if v, err := c.Do(ctx, "INCRBY", key, "5"); err != nil || v != int64(5) {
		t.Fatalf("INCRBY: %v %v", v, err)
	}
	if v, err := c.Do(ctx, "GET", key); err != nil || v != "5" {
		t.Fatalf("GET: %v %v", v, err)
	}
}
