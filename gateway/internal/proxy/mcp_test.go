package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

// mcpUpstream is a small MCP server: three tools, answers as JSON or as
// server-sent events, and records what reached it.
type mcpUpstream struct {
	mu     sync.Mutex
	sse    bool
	calls  []string
	header http.Header
}

func (u *mcpUpstream) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	u.mu.Lock()
	u.header = r.Header.Clone()
	sse := u.sse
	u.mu.Unlock()
	if r.Method == http.MethodDelete {
		w.WriteHeader(http.StatusOK)
		return
	}
	var m struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	json.NewDecoder(r.Body).Decode(&m)
	var result any
	switch m.Method {
	case "initialize":
		w.Header().Set("Mcp-Session-Id", "sess-1")
		result = map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{"tools": map[string]any{}},
			"serverInfo": map[string]any{"name": "demo", "version": "1"}}
	case "tools/list":
		result = map[string]any{"tools": []any{
			map[string]any{"name": "hora", "inputSchema": map[string]any{"type": "object"}},
			map[string]any{"name": "clima", "inputSchema": map[string]any{"type": "object"}},
			map[string]any{"name": "borrar_todo", "inputSchema": map[string]any{"type": "object"}},
		}}
	case "tools/call":
		u.mu.Lock()
		u.calls = append(u.calls, m.Params.Name)
		u.mu.Unlock()
		result = map[string]any{"content": []any{map[string]any{"type": "text", "text": "ok " + m.Params.Name}}}
	}
	out, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": result})
	if sse {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "event: message\nid: 1\ndata: "+string(out)+"\n\n")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(out)
}

func (u *mcpUpstream) seen() ([]string, http.Header) {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.calls...), u.header
}

const mcpPolicy = `{"id":"p","team_id":"t1","version":1,"allow_all_models":true,"mcp_tools":["demo/hora","demo/clima"],"pii_action":"redact","dlp_action":"block"}`

// mcpEnv: the gateway with the MCP server "demo" behind it, its credential
// set in the console.
func mcpEnv(t *testing.T, policyJSON string) (*env, *mcpUpstream, *httptest.Server) {
	t.Helper()
	e := newEnv(t, policyJSON, time.Minute)
	up := &mcpUpstream{}
	upSrv := httptest.NewServer(up)
	t.Cleanup(upSrv.Close)
	st, err := e.h.Holder.State().Apply(&snapshot.SyncResponse{CurrentVersion: 4, MCPServers: []snapshot.WireMCPServer{
		{Name: "demo", URL: upSrv.URL + "/mcp", Headers: map[string]string{"Authorization": "Bearer mcp-secret"}},
	}}, false)
	if err != nil {
		t.Fatal(err)
	}
	e.h.Holder.Store(st, snapshot.Build(st, time.Now()))
	gw := httptest.NewServer(http.HandlerFunc(e.h.MCP))
	t.Cleanup(gw.Close)
	return e, up, gw
}

func mcpCall(t *testing.T, gw *httptest.Server, path, key, body string) (*http.Response, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, gw.URL+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Mcp-Session-Id", "sess-1")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream") {
		for _, l := range strings.Split(string(raw), "\n") {
			if d, ok := strings.CutPrefix(l, "data: "); ok {
				raw = []byte(d)
			}
		}
	}
	var out map[string]any
	json.Unmarshal(raw, &out)
	return res, out
}

func toolNames(msg map[string]any) []string {
	var names []string
	result, _ := msg["result"].(map[string]any)
	tools, _ := result["tools"].([]any)
	for _, t := range tools {
		names = append(names, t.(map[string]any)["name"].(string))
	}
	return names
}

func TestMCPPassesThroughWithTheServersCredential(t *testing.T) {
	_, up, gw := mcpEnv(t, mcpPolicy)
	res, msg := mcpCall(t, gw, "/mcp/demo", devKey, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	if res.StatusCode != 200 || res.Header.Get("Mcp-Session-Id") != "sess-1" || msg["result"] == nil {
		t.Fatalf("initialize: %d %v", res.StatusCode, msg)
	}
	_, h := up.seen()
	if h.Get("Authorization") != "Bearer mcp-secret" || h.Get("Mcp-Session-Id") != "sess-1" {
		t.Errorf("upstream got Authorization %q, session %q", h.Get("Authorization"), h.Get("Mcp-Session-Id"))
	}
}

func TestMCPListsAndCallsOnlyWhatThePolicyAllows(t *testing.T) {
	for _, sse := range []bool{false, true} {
		e, up, gw := mcpEnv(t, mcpPolicy)
		up.mu.Lock()
		up.sse = sse
		up.mu.Unlock()
		_, msg := mcpCall(t, gw, "/mcp/demo", devKey, `{"jsonrpc":"2.0","id":"l1","method":"tools/list"}`)
		if got := strings.Join(toolNames(msg), ","); got != "hora,clima" {
			t.Errorf("sse %v: tools/list %q", sse, got)
		}

		_, msg = mcpCall(t, gw, "/mcp/demo", devKey, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"hora","arguments":{}}}`)
		if result, _ := msg["result"].(map[string]any); result["isError"] == true || result["content"] == nil {
			t.Errorf("sse %v: allowed call %v", sse, msg)
		}
		res, msg := mcpCall(t, gw, "/mcp/demo", devKey, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"borrar_todo","arguments":{}}}`)
		result, _ := msg["result"].(map[string]any)
		if res.StatusCode != 200 || result["isError"] != true || msg["id"].(float64) != 3 {
			t.Errorf("sse %v: refused call %d %v", sse, res.StatusCode, msg)
		}
		if calls, _ := up.seen(); strings.Join(calls, ",") != "hora" {
			t.Errorf("sse %v: reached the server: %v", sse, calls)
		}
		got := e.usage.wait(t, 2)
		if len(got) != 2 || got[0].Provider != "mcp" || got[0].Model != "demo/hora" || got[0].Status != 200 ||
			got[1].Model != "demo/borrar_todo" || got[1].Status != 403 || got[1].Reason != "tool_not_allowed" {
			t.Errorf("sse %v: usage %+v", sse, got)
		}
	}
}

func TestMCPRefusals(t *testing.T) {
	e, up, gw := mcpEnv(t, allowAll) // a policy without MCP tools
	if res, _ := mcpCall(t, gw, "/mcp/demo", devKey, `{"jsonrpc":"2.0","id":1,"method":"initialize"}`); res.StatusCode != 403 {
		t.Errorf("no MCP in the policy: %d", res.StatusCode)
	}
	// Recorded, the server as the model: the attempt shows in Requests.
	if got := e.usage.wait(t, 1); len(got) != 1 || got[0].Provider != "mcp" || got[0].Model != "demo" ||
		got[0].Status != 403 || got[0].Reason != "mcp_server_not_allowed" {
		t.Errorf("server refused: usage %+v", got)
	}
	if res, _ := mcpCall(t, gw, "/mcp/otro", devKey, `{"jsonrpc":"2.0","id":1,"method":"initialize"}`); res.StatusCode != 404 {
		t.Errorf("unknown server: %d", res.StatusCode)
	}
	if res, _ := mcpCall(t, gw, "/mcp/demo", "nope", `{}`); res.StatusCode != 401 {
		t.Errorf("bad key: %d", res.StatusCode)
	}
	if _, h := up.seen(); h != nil {
		t.Error("something reached the server")
	}

	// The whole server: every tool, listed as it comes.
	_, _, gw = mcpEnv(t, strings.Replace(mcpPolicy, `"demo/hora","demo/clima"`, `"demo/*"`, 1))
	if _, msg := mcpCall(t, gw, "/mcp/demo", devKey, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`); len(toolNames(msg)) != 3 {
		t.Errorf("demo/*: %v", toolNames(msg))
	}
	// A batch with a refused call is refused whole.
	_, _, gw = mcpEnv(t, mcpPolicy)
	req, _ := http.NewRequest(http.MethodPost, gw.URL+"/mcp/demo",
		strings.NewReader(`[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hora"}},{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"borrar_todo"}}]`))
	req.Header.Set("Authorization", "Bearer "+devKey)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Errorf("batch: %d", res.StatusCode)
	}
}
