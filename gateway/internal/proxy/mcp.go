package proxy

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/getstratum/stratum/gateway/internal/decision"
	"github.com/getstratum/stratum/gateway/internal/policy"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
	"github.com/getstratum/stratum/gateway/internal/usage"
)

// MCP serves /mcp/{server} (ADR-0016): an agent reaches the organization's
// MCP servers through the gateway, with its own Stratum key, and never sees
// the server's credential, which the gateway adds.
//
// The transport is MCP's Streamable HTTP: JSON-RPC messages POSTed to one
// endpoint, answered with JSON or a stream of server-sent events; GET opens
// a stream for the server's own messages, DELETE ends a session. Everything
// is passed through, with these exceptions:
//
//   - the caller's policy must allow the server ("server/*" or any
//     "server/tool"), or the request is refused (403);
//   - a tools/call to a tool the policy does not allow is answered by the
//     gateway, as a tool result with isError, so the agent's model reads
//     why and can go on; nothing reaches the server;
//   - the answer to tools/list leaves out the tools the policy does not
//     allow. That is a courtesy: what is enforced is the call;
//   - with decision services (ADR-0014), each call the policy allows is
//     checked by them first (ADR-0017); one they refuse is answered like a
//     call the policy does not allow, with their message.
//
// Each tools/call is a usage record (provider "mcp", model
// "server/tool"), refused ones too, so the console shows them in Requests;
// so is a request refused because the policy does not allow the server
// (model "server").
func (h *Handler) MCP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	status, reason := http.StatusOK, "ok"
	defer func() { h.Metrics.Request(status, "", reason) }()
	fail := func(v *policy.Violation) {
		status, reason = v.Status, v.Code
		h.fail(w, &record{}, v)
	}

	snap := h.Holder.Load()
	if snap == nil {
		fail(&policy.Violation{Status: http.StatusServiceUnavailable, Code: "not_ready", Message: "gateway has no configuration yet"})
		return
	}
	name, rest, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/mcp/"), "/")
	name = strings.ToLower(name)
	key, teamID, userID, v := h.caller(r, snap)
	if v != nil {
		fail(v)
		return
	}
	pol, found := snap.PolicyForTeam(teamID)
	if v := policyUsable(pol, found); v != nil {
		fail(v)
		return
	}
	srv, ok := snap.MCP(name)
	if !ok {
		fail(&policy.Violation{Status: http.StatusNotFound, Code: "mcp_server_not_found",
			Message: "there is no MCP server " + name + " in this organization"})
		return
	}
	// The application's labels, as on a model request: on every record of
	// this request and for the decision services.
	appLabels, valid := parseLabels(r.Header.Values("X-Stratum-Labels"))
	if !valid {
		fail(&policy.Violation{Status: http.StatusBadRequest, Code: "invalid_labels",
			Message: "X-Stratum-Labels takes up to 8 comma-separated labels of lowercase letters, digits and _ (1 to 40 each)"})
		return
	}
	version, ok := agentVersion(r)
	if !ok {
		fail(badAgentVersion)
		return
	}
	// The task, as on a model request: on every record (ADR-0019) and for
	// the decision services.
	task := ""
	if t := strings.TrimSpace(r.Header.Get("X-Stratum-Task")); t != "" {
		if !validTask(t) {
			fail(&policy.Violation{Status: http.StatusBadRequest, Code: "invalid_task",
				Message: "X-Stratum-Task takes 1 to 100 letters, digits and . _ : -"})
			return
		}
		task = t
	}
	// model is "server/tool" for a call, the server alone when the server
	// itself is refused.
	ip, ua := h.origin(r)
	report := func(model string, st int, why string, labels ...string) {
		if h.Usage == nil {
			return
		}
		h.Usage.Add(usage.Record{
			ID: usage.NewID(), Time: start.UTC(), KeyID: key.ID, UserID: userID, TeamID: teamID, Task: task, AgentVersion: version,
			Provider: "mcp", Model: usage.Clip(model, 100), Status: st, Reason: why,
			DurationMs: time.Since(start).Milliseconds(), Labels: mergeLabels(mergeLabels([]string{"mcp"}, appLabels), labels),
			ClientIP: ip, UserAgent: ua,
		})
	}
	if !pol.MCPAllowed(name, "") {
		// Recorded too: an agent trying a server its team may not use is
		// what an audit looks for.
		report(name, http.StatusForbidden, "mcp_server_not_allowed")
		fail(&policy.Violation{Status: http.StatusForbidden, Code: "mcp_server_not_allowed",
			Message: "this team's policy does not allow the MCP server " + name})
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodGet && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "GET, POST, DELETE")
		fail(&policy.Violation{Status: http.StatusMethodNotAllowed, Code: "method_not_allowed", Message: "MCP takes GET, POST and DELETE"})
		return
	}

	// What the agent sends: the tools it calls, and the lists it asks for.
	var raw []byte
	var msgs []mcpMessage
	batch := false
	if r.Method == http.MethodPost {
		var err error
		raw, err = io.ReadAll(http.MaxBytesReader(w, r.Body, h.MaxRequestBytes))
		if err != nil {
			fail(&policy.Violation{Status: http.StatusRequestEntityTooLarge, Code: "request_too_large", Message: "request body is too large"})
			return
		}
		if msgs, batch, err = parseMCP(raw); err != nil {
			fail(&policy.Violation{Status: http.StatusBadRequest, Code: "invalid_json", Message: "an MCP request is a JSON-RPC message"})
			return
		}
	}
	var calls []mcpMessage
	lists := map[string]bool{}
	var refused []mcpMessage
	for _, m := range msgs {
		switch m.Method {
		case "tools/call":
			if !pol.MCPAllowed(name, m.Params.Name) {
				refused = append(refused, m)
				continue
			}
			calls = append(calls, m)
		case "tools/list":
			lists[string(m.ID)] = true
		}
	}
	if len(refused) > 0 {
		for _, m := range refused {
			report(name+"/"+m.Params.Name, http.StatusForbidden, "tool_not_allowed")
		}
		status, reason = http.StatusForbidden, "tool_not_allowed"
		w.Header().Set("Content-Type", "application/json")
		if !batch {
			// A tool result, not a protocol error: the agent's model reads
			// it and can do something else.
			json.NewEncoder(w).Encode(refusal(refused[0], policyRefusal(refused[0].Params.Name)))
			return
		}
		// A batch (MCP before 2025-06-18) with a refused call is refused whole.
		out := make([]any, 0, len(msgs))
		for _, m := range msgs {
			if len(m.ID) > 0 {
				out = append(out, map[string]any{"jsonrpc": "2.0", "id": m.ID,
					"error": map[string]any{"code": -32001, "message": "this batch calls a tool this team's policy does not allow"}})
			}
		}
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(out)
		return
	}

	// The decision services (ADR-0014), on each call the policy allows
	// (ADR-0017). The first refusal decides, as for a model request.
	type checked struct {
		sum    string
		labels []string
	}
	checks := make([]checked, len(calls))
	denied := false
	if h.Decision != nil {
		var requestID string
		if h.RequestID != nil {
			requestID = h.RequestID(r.Context())
		}
		rep := func(m mcpMessage, c checked, st int, why string) {
			h.Decision.Report(decision.Report{
				RequestID: usage.Clip(requestID, 128), Time: start.UTC().Format(time.RFC3339Nano),
				KeyID: key.ID, TeamID: teamID, UserID: userID, Task: task, Provider: "mcp",
				Model: usage.Clip(name+"/"+m.Params.Name, 100), ContentSHA256: c.sum,
				Status: st, Reason: why, DurationMs: time.Since(start).Milliseconds(),
			})
		}
		defer func() {
			// How each call that was sent ended.
			if !denied {
				for i, m := range calls {
					rep(m, checks[i], status, reason)
				}
			}
		}()
		for i, m := range calls {
			canon, sum := toolArguments(m.Params.Arguments)
			tool := &decision.Tool{Server: name, Name: m.Params.Name, ArgumentsSHA256: sum}
			if h.ToolArguments {
				if len(canon) <= decision.MaxToolArguments {
					tool.Arguments = canon
				} else {
					tool.ArgumentsOmitted = "too_large"
				}
			}
			d := h.Decision.Check(r.Context(), decision.Request{
				RequestID: requestID, Time: start.UTC().Format(time.RFC3339Nano),
				KeyID: key.ID, KeyLabel: key.Label, TeamID: teamID, UserID: userID, Task: task,
				Provider: "mcp", Model: name + "/" + m.Params.Name, Operation: decision.OperationToolCall,
				Labels: mergeLabels([]string{"mcp"}, appLabels), ContentSHA256: sum, ContentBytes: len(canon), Tool: tool,
			})
			checks[i] = checked{sum: sum, labels: d.Labels}
			if d.Skipped {
				checks[i].labels = append(checks[i].labels, "decision_skipped")
			}
			for k, v := range d.Headers {
				w.Header().Set(k, v)
			}
			if d.Allow {
				continue
			}
			report(name+"/"+m.Params.Name, d.Status, d.Code)
			rep(m, checks[i], d.Status, d.Code)
			status, reason, denied = d.Status, d.Code, true
			w.Header().Set("Content-Type", "application/json")
			if !batch {
				json.NewEncoder(w).Encode(refusal(m, "Stratum: "+d.Message))
				return
			}
			out := make([]any, 0, len(msgs))
			for _, o := range msgs {
				if len(o.ID) > 0 {
					out = append(out, map[string]any{"jsonrpc": "2.0", "id": o.ID,
						"error": map[string]any{"code": -32001, "message": "this batch calls a tool that was refused: " + d.Message}})
				}
			}
			w.WriteHeader(d.Status)
			json.NewEncoder(w).Encode(out)
			return
		}
	}

	// To the server, with its headers and none of the agent's credentials.
	target := srv.URL
	if rest != "" {
		target = strings.TrimRight(target, "/") + "/" + rest
	}
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target, bytes.NewReader(raw))
	if err != nil {
		fail(&policy.Violation{Status: http.StatusBadGateway, Code: "mcp_misconfigured", Message: "the MCP server's address is not valid"})
		return
	}
	for _, k := range []string{"Content-Type", "Accept", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-Id"} {
		if v := r.Header.Get(k); v != "" {
			req.Header.Set(k, v)
		}
	}
	for k, v := range srv.Headers {
		req.Header.Set(k, v)
	}
	if h.UserAgent != "" {
		req.Header.Set("User-Agent", h.UserAgent)
	}
	res, err := h.Client.Do(req)
	if err != nil {
		for i, m := range calls {
			report(name+"/"+m.Params.Name, http.StatusBadGateway, "upstream_error", checks[i].labels...)
		}
		code := "upstream_error"
		if errors.Is(r.Context().Err(), context.Canceled) {
			code = "client_closed"
		}
		fail(&policy.Violation{Status: http.StatusBadGateway, Code: code, Message: "the MCP server " + name + " could not be reached"})
		status, reason = http.StatusBadGateway, code
		return
	}
	defer res.Body.Close()
	status = res.StatusCode
	if status >= 400 {
		reason = "upstream_status"
	}
	for i, m := range calls {
		report(name+"/"+m.Params.Name, status, reason, checks[i].labels...)
	}

	for _, k := range []string{"Content-Type", "Mcp-Session-Id", "Mcp-Protocol-Version", "Cache-Control", "Www-Authenticate"} {
		if v := res.Header.Get(k); v != "" {
			w.Header().Set(k, v)
		}
	}
	ct := res.Header.Get("Content-Type")
	filter := len(lists) > 0 && !allTools(pol, name)
	switch {
	case filter && strings.HasPrefix(ct, "application/json"):
		body, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
		if err != nil {
			status, reason = http.StatusBadGateway, "upstream_error"
			return
		}
		w.WriteHeader(res.StatusCode)
		w.Write(filterTools(body, lists, pol, name))
	case strings.HasPrefix(ct, "text/event-stream"):
		w.WriteHeader(res.StatusCode)
		streamEvents(w, res.Body, func(data []byte) []byte {
			if !filter {
				return data
			}
			return filterTools(data, lists, pol, name)
		})
	default:
		w.WriteHeader(res.StatusCode)
		flushCopy(w, res.Body)
	}
}

// mcpMessage is what the gateway reads of a JSON-RPC message.
type mcpMessage struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method"`
	Params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"params"`
}

// toolArguments: a call's arguments, re-encoded with sorted keys and their
// numbers as written, and their SHA-256. The same arguments in another
// order have the same hash: a decision service matches a call it saw
// (an approval, a loop) by it.
func toolArguments(raw json.RawMessage) ([]byte, string) {
	canon := []byte("{}")
	if t := bytes.TrimSpace(raw); len(t) > 0 && !bytes.Equal(t, []byte("null")) {
		dec := json.NewDecoder(bytes.NewReader(t))
		dec.UseNumber()
		var v any
		if dec.Decode(&v) == nil {
			if b, err := json.Marshal(v); err == nil {
				canon = b
			}
		} else {
			canon = t
		}
	}
	sum := sha256.Sum256(canon)
	return canon, hex.EncodeToString(sum[:])
}

func parseMCP(raw []byte) ([]mcpMessage, bool, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) > 0 && raw[0] == '[' {
		var msgs []mcpMessage
		err := json.Unmarshal(raw, &msgs)
		return msgs, true, err
	}
	var m mcpMessage
	err := json.Unmarshal(raw, &m)
	return []mcpMessage{m}, false, err
}

// refusal answers a call the gateway did not send, as a tool result with
// isError: the agent's model reads why and can do something else.
func refusal(m mcpMessage, text string) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{
		"isError": true,
		"content": []any{map[string]any{"type": "text", "text": text}},
	}}
}

func policyRefusal(tool string) string {
	return "Stratum: la política de este equipo no permite la herramienta " + tool + ". (This team's policy does not allow this tool.)"
}

// allTools: the policy allows the server as a whole ("server/*").
func allTools(pol snapshot.Policy, server string) bool {
	_, ok := pol.MCPTools[server+"/*"]
	return ok
}

// filterTools leaves out of a tools/list result (one message, or a batch)
// the tools the policy does not allow. Anything else is returned as it was.
func filterTools(body []byte, lists map[string]bool, pol snapshot.Policy, server string) []byte {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		var msgs []json.RawMessage
		if json.Unmarshal(trimmed, &msgs) != nil {
			return body
		}
		for i, m := range msgs {
			msgs[i] = filterTools(m, lists, pol, server)
		}
		out, err := json.Marshal(msgs)
		if err != nil {
			return body
		}
		return out
	}
	var msg map[string]json.RawMessage
	if json.Unmarshal(trimmed, &msg) != nil || !lists[string(msg["id"])] {
		return body
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(msg["result"], &result) != nil {
		return body
	}
	var tools []json.RawMessage
	if json.Unmarshal(result["tools"], &tools) != nil {
		return body
	}
	kept := make([]json.RawMessage, 0, len(tools))
	for _, t := range tools {
		var tool struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(t, &tool) == nil && pol.MCPAllowed(server, tool.Name) {
			kept = append(kept, t)
		}
	}
	result["tools"], _ = json.Marshal(kept)
	msg["result"], _ = json.Marshal(result)
	out, err := json.Marshal(msg)
	if err != nil {
		return body
	}
	return out
}

// streamEvents passes server-sent events through, one at a time, with each
// event's data (its "data:" lines joined) through fn.
func streamEvents(w http.ResponseWriter, body io.Reader, fn func([]byte) []byte) {
	flusher, _ := w.(http.Flusher)
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 64<<10), 16<<20)
	var other [][]byte
	var data [][]byte
	emit := func() {
		for _, l := range other {
			w.Write(l)
			w.Write([]byte("\n"))
		}
		if len(data) > 0 {
			joined := fn(bytes.Join(data, []byte("\n")))
			for _, l := range bytes.Split(joined, []byte("\n")) {
				w.Write([]byte("data: "))
				w.Write(l)
				w.Write([]byte("\n"))
			}
		}
		w.Write([]byte("\n"))
		if flusher != nil {
			flusher.Flush()
		}
		other, data = nil, nil
	}
	for sc.Scan() {
		line := sc.Bytes()
		switch {
		case len(line) == 0:
			if len(other) > 0 || len(data) > 0 {
				emit()
			}
		case bytes.HasPrefix(line, []byte("data:")):
			d := bytes.TrimPrefix(line, []byte("data:"))
			d = bytes.TrimPrefix(d, []byte(" "))
			data = append(data, append([]byte(nil), d...))
		default:
			other = append(other, append([]byte(nil), line...))
		}
	}
	if len(other) > 0 || len(data) > 0 {
		emit()
	}
}

func flushCopy(w http.ResponseWriter, body io.Reader) {
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32<<10)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			w.Write(buf[:n])
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}
