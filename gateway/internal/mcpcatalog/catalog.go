// Package mcpcatalog tells the control plane which tools each MCP server
// offers (ADR-0016, "What each server offers"): the console and the
// Enterprise portal show them to whoever administers the servers, whatever
// their own team's policy lets them use. The console never calls the
// servers (they are in the gateways' network, and an address an
// administrator types is not one the console should reach); gateways do,
// with the server's credential, as for an agent's request.
//
// Only tools/list: no tool is called. A gateway lists every server of its
// snapshot when that list changes and every Every, and sends the result to
// POST {URL}/api/internal/mcp-catalog with its sync token. Each replica
// does it: the console keeps the last report of each server.
package mcpcatalog

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

const (
	// MaxTools a server reports; the rest are left out.
	MaxTools = 200
	// maxDescription characters of a tool's description.
	maxDescription = 300
	maxPages       = 5
	maxBody        = 4 << 20
	protocol       = "2025-06-18"
	check          = 30 * time.Second
)

// Tool is one tool as the console stores it.
type Tool struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	ReadOnly    bool   `json:"read_only,omitempty"` // what the server says (readOnlyHint): a hint, not a guarantee
}

// Server is what a gateway saw of one server: its tools, or why not.
type Server struct {
	Name  string `json:"name"`
	Tools []Tool `json:"tools"`
	Error string `json:"error,omitempty"`
}

// Report is the body of POST /api/internal/mcp-catalog.
type Report struct {
	InstanceID string   `json:"instance_id,omitempty"`
	Servers    []Server `json:"servers"`
}

// Reporter lists and reports. Client reaches the MCP servers; CPClient the
// control plane.
type Reporter struct {
	URL, Token, InstanceID, UserAgent string

	Holder   *snapshot.Holder
	Servers  func(*snapshot.Snapshot) []snapshot.MCPServer // default: the snapshot's (tests)
	Client   *http.Client
	CPClient *http.Client
	Every    time.Duration
	Timeout  time.Duration // per server
	Log      *slog.Logger

	now  func() time.Time
	last string    // the servers last listed (their fingerprint)
	at   time.Time // when
}

// Run lists and reports until ctx ends.
func (r *Reporter) Run(ctx context.Context) {
	t := time.NewTicker(check)
	defer t.Stop()
	for {
		if err := r.Once(ctx); err != nil && ctx.Err() == nil {
			r.Log.Warn("MCP catalog not reported; trying again later", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (r *Reporter) clock() time.Time {
	if r.now != nil {
		return r.now()
	}
	return time.Now()
}

// Once lists and reports when the servers changed or Every passed.
func (r *Reporter) Once(ctx context.Context) error {
	snap := r.Holder.Load()
	if snap == nil {
		return nil
	}
	servers := snap.MCPServers()
	if r.Servers != nil {
		servers = r.Servers(snap)
	}
	fp := fingerprint(servers)
	if fp == r.last && r.clock().Sub(r.at) < r.Every {
		return nil
	}
	rep := Report{InstanceID: r.InstanceID, Servers: make([]Server, 0, len(servers))}
	for _, s := range servers {
		rep.Servers = append(rep.Servers, r.list(ctx, s))
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err := r.send(ctx, rep); err != nil {
		return err
	}
	r.last, r.at = fp, r.clock()
	return nil
}

// fingerprint: what makes a new list worth it (a server added, moved, or a
// new credential).
func fingerprint(servers []snapshot.MCPServer) string {
	h := sha256.New()
	for _, s := range servers {
		fmt.Fprintf(h, "%s\x00%s\x00", s.Name, s.URL)
		keys := make([]string, 0, len(s.Headers))
		for k := range s.Headers {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Fprintf(h, "%s=%s\x00", k, s.Headers[k])
		}
		h.Write([]byte{1})
	}
	return hex.EncodeToString(h.Sum(nil))
}

func (r *Reporter) list(ctx context.Context, s snapshot.MCPServer) Server {
	ctx, cancel := context.WithTimeout(ctx, r.Timeout)
	defer cancel()
	tools, err := r.tools(ctx, s)
	if err != nil {
		return Server{Name: s.Name, Tools: []Tool{}, Error: err.Error()}
	}
	return Server{Name: s.Name, Tools: tools}
}

// errStatus: the server answered with an HTTP error.
type errStatus int

func (e errStatus) Error() string { return fmt.Sprintf("the server answered %d", int(e)) }

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type message struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

// session is one conversation with a server: its session id, once given.
type session struct {
	r   *Reporter
	srv snapshot.MCPServer
	id  string
}

func (r *Reporter) tools(ctx context.Context, srv snapshot.MCPServer) ([]Tool, error) {
	ss := &session{r: r, srv: srv}
	defer ss.end()
	if _, err := ss.call(ctx, 1, "initialize", map[string]any{
		"protocolVersion": protocol, "capabilities": map[string]any{},
		"clientInfo": map[string]any{"name": "stratum-gateway", "version": "catalog"},
	}); err != nil {
		return nil, fmt.Errorf("initialize: %w", err)
	}
	if err := ss.notify(ctx, "notifications/initialized"); err != nil {
		return nil, fmt.Errorf("initialized: %w", err)
	}
	out := []Tool{}
	cursor := ""
	for page := 0; page < maxPages && len(out) < MaxTools; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := ss.call(ctx, 2+page, "tools/list", params)
		if err != nil {
			return nil, fmt.Errorf("tools/list: %w", err)
		}
		var res struct {
			Tools []struct {
				Name        string `json:"name"`
				Description string `json:"description"`
				Annotations struct {
					ReadOnlyHint *bool `json:"readOnlyHint"`
				} `json:"annotations"`
			} `json:"tools"`
			NextCursor string `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &res); err != nil {
			return nil, errors.New("tools/list: the answer is not a list of tools")
		}
		for _, t := range res.Tools {
			if t.Name == "" || len(t.Name) > 128 || len(out) == MaxTools {
				continue
			}
			out = append(out, Tool{Name: t.Name, Description: clip(t.Description), ReadOnly: t.Annotations.ReadOnlyHint != nil && *t.Annotations.ReadOnlyHint})
		}
		if res.NextCursor == "" {
			break
		}
		cursor = res.NextCursor
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func clip(s string) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > maxDescription {
		return string(r[:maxDescription])
	}
	return s
}

func (ss *session) request(ctx context.Context, method string, body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, ss.srv.URL, bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("the server's address is not valid")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Mcp-Protocol-Version", protocol)
	if ss.id != "" {
		req.Header.Set("Mcp-Session-Id", ss.id)
	}
	for k, v := range ss.srv.Headers {
		req.Header.Set(k, v)
	}
	if ss.r.UserAgent != "" {
		req.Header.Set("User-Agent", ss.r.UserAgent)
	}
	res, err := ss.r.Client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, errors.New("the server did not answer in time")
		}
		return nil, errors.New("the server could not be reached")
	}
	return res, nil
}

func (ss *session) call(ctx context.Context, id int, method string, params any) (json.RawMessage, error) {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	res, err := ss.request(ctx, http.MethodPost, body)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return nil, errStatus(res.StatusCode)
	}
	if v := res.Header.Get("Mcp-Session-Id"); v != "" {
		ss.id = v
	}
	want := fmt.Sprint(id)
	pick := func(data []byte) (*message, bool) {
		var m message
		if json.Unmarshal(data, &m) != nil || strings.Trim(string(m.ID), `"`) != want {
			return nil, false
		}
		return &m, true
	}
	var m *message
	if strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream") {
		sc := bufio.NewScanner(io.LimitReader(res.Body, maxBody))
		sc.Buffer(make([]byte, 64<<10), maxBody)
		var data []byte
		for sc.Scan() && m == nil {
			line := sc.Bytes()
			switch {
			case bytes.HasPrefix(line, []byte("data:")):
				data = append(data, bytes.TrimSpace(line[5:])...)
			case len(line) == 0 && len(data) > 0:
				m, _ = pick(data)
				data = nil
			}
		}
		if m == nil && len(data) > 0 {
			m, _ = pick(data)
		}
	} else {
		raw, err := io.ReadAll(io.LimitReader(res.Body, maxBody))
		if err != nil {
			return nil, errors.New("the answer could not be read")
		}
		m, _ = pick(raw)
	}
	switch {
	case m == nil:
		return nil, errors.New("no answer to the request")
	case m.Error != nil:
		return nil, fmt.Errorf("the server answered an error: %s", clip(m.Error.Message))
	}
	return m.Result, nil
}

func (ss *session) notify(ctx context.Context, method string) error {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method})
	res, err := ss.request(ctx, http.MethodPost, body)
	if err != nil {
		return err
	}
	io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	res.Body.Close()
	if res.StatusCode >= 400 {
		return errStatus(res.StatusCode)
	}
	return nil
}

// end closes the session, if the server gave one; best effort.
func (ss *session) end() {
	if ss.id == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if res, err := ss.request(ctx, http.MethodDelete, nil); err == nil {
		res.Body.Close()
	}
}

func (r *Reporter) send(ctx context.Context, rep Report) error {
	body, err := json.Marshal(rep)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.URL+"/api/internal/mcp-catalog", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+r.Token)
	req.Header.Set("Content-Type", "application/json")
	if r.UserAgent != "" {
		req.Header.Set("User-Agent", r.UserAgent)
	}
	res, err := r.CPClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	snippet, _ := io.ReadAll(io.LimitReader(res.Body, 4<<10))
	if res.StatusCode == http.StatusNotFound {
		// An older control plane: nothing to tell it; try again at Every.
		r.Log.Debug("control plane has no MCP catalog (before 0.9)")
		return nil
	}
	if res.StatusCode >= 300 {
		return fmt.Errorf("control plane answered %d: %s", res.StatusCode, bytes.TrimSpace(snippet))
	}
	return nil
}
