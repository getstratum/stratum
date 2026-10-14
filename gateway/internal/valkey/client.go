// Package valkey is a minimal client for Valkey and Redis (RESP2), written
// against the standard library only.
//
// It covers what the gateway needs and nothing more: one connection, one
// command at a time, AUTH and SELECT on connect, optional TLS, and per-call
// deadlines. Any network or protocol error closes the connection so the next
// call starts on a fresh one. Server error replies (-ERR ...) are returned as
// Error and leave the connection open.
package valkey

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Error is an error reply from the server.
type Error string

func (e Error) Error() string { return string(e) }

const (
	maxBulkLen  = 64 << 20 // replies larger than this are treated as a protocol error
	maxArrayLen = 1 << 20
)

// Options configure a Client. Use ParseURL to build them from a URL.
type Options struct {
	Addr        string
	TLS         *tls.Config // nil means plain TCP
	Username    string
	Password    string
	DB          int
	DialTimeout time.Duration
	IOTimeout   time.Duration // bound for one command (write + read) when ctx has no earlier deadline
}

// ParseURL accepts redis://, rediss://, valkey:// and valkeys:// URLs:
//
//	redis://[user:password@]host[:6379][/db]
//
// The "s" schemes use TLS.
func ParseURL(raw string) (Options, error) {
	u, err := url.Parse(raw)
	if err != nil {
		// The url.Parse error quotes the input, which may hold a password.
		return Options{}, errors.New("invalid URL")
	}
	o := Options{DialTimeout: 2 * time.Second, IOTimeout: time.Second}
	switch u.Scheme {
	case "redis", "valkey":
	case "rediss", "valkeys":
		o.TLS = &tls.Config{MinVersion: tls.VersionTLS12, ServerName: u.Hostname()}
	default:
		return Options{}, fmt.Errorf("unsupported scheme %q (use redis://, rediss://, valkey:// or valkeys://)", u.Scheme)
	}
	if u.Hostname() == "" {
		return Options{}, errors.New("missing host")
	}
	port := u.Port()
	if port == "" {
		port = "6379"
	}
	o.Addr = net.JoinHostPort(u.Hostname(), port)
	if u.User != nil {
		o.Password, _ = u.User.Password()
		o.Username = u.User.Username()
		if _, hasPass := u.User.Password(); !hasPass {
			// redis://secret@host: a lone user-info is the password.
			o.Password, o.Username = o.Username, ""
		}
	}
	if p := strings.Trim(u.Path, "/"); p != "" {
		db, err := strconv.Atoi(p)
		if err != nil || db < 0 {
			return Options{}, fmt.Errorf("invalid database %q", p)
		}
		o.DB = db
	}
	return o, nil
}

// Client is safe for concurrent use; commands are serialised.
type Client struct {
	opts Options

	mu   sync.Mutex
	conn net.Conn
	br   *bufio.Reader
	bw   *bufio.Writer
}

func New(o Options) *Client {
	if o.DialTimeout <= 0 {
		o.DialTimeout = 2 * time.Second
	}
	if o.IOTimeout <= 0 {
		o.IOTimeout = time.Second
	}
	return &Client{opts: o}
}

// Do sends one command and returns its reply: string (simple or bulk),
// int64, nil, []any, or an Error value for server errors (also returned as
// the error).
func (c *Client) Do(ctx context.Context, args ...string) (any, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if c.conn == nil {
		if err := c.connect(ctx); err != nil {
			return nil, err
		}
	}
	reply, err := c.roundTrip(ctx, args)
	if err != nil {
		var se Error
		if !errors.As(err, &se) {
			c.closeLocked()
		}
		return nil, err
	}
	return reply, nil
}

// Close closes the current connection, if any. The client stays usable.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closeLocked()
	return nil
}

func (c *Client) closeLocked() {
	if c.conn != nil {
		c.conn.Close()
		c.conn, c.br, c.bw = nil, nil, nil
	}
}

func (c *Client) connect(ctx context.Context) error {
	d := &net.Dialer{Timeout: c.opts.DialTimeout, KeepAlive: 30 * time.Second}
	var (
		conn net.Conn
		err  error
	)
	if c.opts.TLS != nil {
		conn, err = (&tls.Dialer{NetDialer: d, Config: c.opts.TLS}).DialContext(ctx, "tcp", c.opts.Addr)
	} else {
		conn, err = d.DialContext(ctx, "tcp", c.opts.Addr)
	}
	if err != nil {
		return err
	}
	c.conn, c.br, c.bw = conn, bufio.NewReader(conn), bufio.NewWriter(conn)

	if c.opts.Password != "" {
		args := []string{"AUTH", c.opts.Password}
		if c.opts.Username != "" {
			args = []string{"AUTH", c.opts.Username, c.opts.Password}
		}
		if _, err := c.roundTrip(ctx, args); err != nil {
			c.closeLocked()
			return fmt.Errorf("AUTH: %w", err)
		}
	}
	if c.opts.DB != 0 {
		if _, err := c.roundTrip(ctx, []string{"SELECT", strconv.Itoa(c.opts.DB)}); err != nil {
			c.closeLocked()
			return fmt.Errorf("SELECT: %w", err)
		}
	}
	return nil
}

func (c *Client) roundTrip(ctx context.Context, args []string) (any, error) {
	deadline := time.Now().Add(c.opts.IOTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := c.conn.SetDeadline(deadline); err != nil {
		return nil, err
	}
	if err := writeCommand(c.bw, args); err != nil {
		return nil, err
	}
	if err := c.bw.Flush(); err != nil {
		return nil, err
	}
	reply, err := readReply(c.br, 0)
	if err != nil {
		return nil, err
	}
	if se, ok := reply.(Error); ok {
		return nil, se
	}
	return reply, nil
}

func writeCommand(w *bufio.Writer, args []string) error {
	fmt.Fprintf(w, "*%d\r\n", len(args))
	for _, a := range args {
		fmt.Fprintf(w, "$%d\r\n", len(a))
		w.WriteString(a)
		if _, err := w.WriteString("\r\n"); err != nil {
			return err
		}
	}
	return nil
}

// ErrProtocol reports a malformed or oversized reply.
var ErrProtocol = errors.New("valkey: protocol error")

func readReply(r *bufio.Reader, depth int) (any, error) {
	if depth > 8 {
		return nil, fmt.Errorf("%w: reply nested too deeply", ErrProtocol)
	}
	line, err := readLine(r)
	if err != nil {
		return nil, err
	}
	if len(line) == 0 {
		return nil, fmt.Errorf("%w: empty line", ErrProtocol)
	}
	body := line[1:]
	switch line[0] {
	case '+':
		return body, nil
	case '-':
		return Error(body), nil
	case ':':
		n, err := strconv.ParseInt(body, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("%w: bad integer %q", ErrProtocol, body)
		}
		return n, nil
	case '$':
		n, err := strconv.Atoi(body)
		if err != nil || n < -1 || n > maxBulkLen {
			return nil, fmt.Errorf("%w: bad bulk length %q", ErrProtocol, body)
		}
		if n == -1 {
			return nil, nil
		}
		buf := make([]byte, n+2)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, err
		}
		if buf[n] != '\r' || buf[n+1] != '\n' {
			return nil, fmt.Errorf("%w: bulk not terminated", ErrProtocol)
		}
		return string(buf[:n]), nil
	case '*':
		n, err := strconv.Atoi(body)
		if err != nil || n < -1 || n > maxArrayLen {
			return nil, fmt.Errorf("%w: bad array length %q", ErrProtocol, body)
		}
		if n == -1 {
			return nil, nil
		}
		out := make([]any, n)
		for i := range out {
			v, err := readReply(r, depth+1)
			if err != nil {
				return nil, err
			}
			out[i] = v
		}
		return out, nil
	default:
		return nil, fmt.Errorf("%w: unexpected type %q", ErrProtocol, line[0])
	}
}

func readLine(r *bufio.Reader) (string, error) {
	line, err := r.ReadSlice('\n')
	if err != nil {
		if errors.Is(err, bufio.ErrBufferFull) {
			return "", fmt.Errorf("%w: line too long", ErrProtocol)
		}
		return "", err
	}
	if len(line) < 2 || line[len(line)-2] != '\r' {
		return "", fmt.Errorf("%w: line not CRLF-terminated", ErrProtocol)
	}
	return string(line[:len(line)-2]), nil
}

// Int converts an integer reply (or a numeric bulk string) to int64.
func Int(v any) (int64, error) {
	switch x := v.(type) {
	case int64:
		return x, nil
	case string:
		return strconv.ParseInt(x, 10, 64)
	case nil:
		return 0, nil
	}
	return 0, fmt.Errorf("%w: expected integer, got %T", ErrProtocol, v)
}
