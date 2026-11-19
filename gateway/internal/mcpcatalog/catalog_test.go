package mcpcatalog

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

// mcpServer answers initialize and tools/list; sse answers in events, pages
// splits the list in two, key is the credential it expects.
func mcpServer(t *testing.T, sse, pages bool, key string) (*httptest.Server, *[]string) {
	var mu sync.Mutex
	var calls []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != key {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.Method == http.MethodDelete {
			mu.Lock()
			calls = append(calls, "DELETE "+r.Header.Get("Mcp-Session-Id"))
			mu.Unlock()
			return
		}
		var m struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				Cursor string `json:"cursor"`
			} `json:"params"`
		}
		json.NewDecoder(r.Body).Decode(&m)
		mu.Lock()
		calls = append(calls, m.Method+" "+r.Header.Get("Mcp-Session-Id"))
		mu.Unlock()
		var result any
		switch m.Method {
		case "initialize":
			w.Header().Set("Mcp-Session-Id", "s-1")
			result = map[string]any{"protocolVersion": protocol, "capabilities": map[string]any{"tools": map[string]any{}}}
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
			return
		case "tools/list":
			hora := map[string]any{"name": "hora", "description": "  La hora.  ", "annotations": map[string]any{"readOnlyHint": true}}
			borrar := map[string]any{"name": "borrar_todo", "description": strings.Repeat("x", 400)}
			switch {
			case !pages:
				result = map[string]any{"tools": []any{hora, borrar}}
			case m.Params.Cursor == "":
				result = map[string]any{"tools": []any{hora}, "nextCursor": "p2"}
			default:
				result = map[string]any{"tools": []any{borrar}}
			}
		}
		msg, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": result})
		if sse {
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, "event: message\ndata: "+string(msg)+"\n\n")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(msg)
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func holderWith(servers ...snapshot.WireMCPServer) *snapshot.Holder {
	st := &snapshot.State{Version: 1, MCP: servers}
	h := &snapshot.Holder{}
	h.Store(st, snapshot.Build(st, time.Now()))
	return h
}

func controlPlane(t *testing.T, status int) (*httptest.Server, *[]Report) {
	var mu sync.Mutex
	var got []Report
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/internal/mcp-catalog" || r.Header.Get("Authorization") != "Bearer sync-tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var rep Report
		json.NewDecoder(r.Body).Decode(&rep)
		mu.Lock()
		got = append(got, rep)
		mu.Unlock()
		w.WriteHeader(status)
	}))
	t.Cleanup(cp.Close)
	return cp, &got
}

func reporter(cp string, h *snapshot.Holder) *Reporter {
	return &Reporter{URL: cp, Token: "sync-tok", InstanceID: "gw-1", Holder: h, Client: &http.Client{}, CPClient: &http.Client{},
		Every: 10 * time.Minute, Timeout: 2 * time.Second, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

func TestListsEachServerAndReports(t *testing.T) {
	plain, calls := mcpServer(t, false, false, "k1")
	events, _ := mcpServer(t, true, true, "k2")
	cp, got := controlPlane(t, http.StatusOK)
	h := holderWith(
		snapshot.WireMCPServer{Name: "demo", URL: plain.URL, Headers: map[string]string{"X-API-Key": "k1"}},
		snapshot.WireMCPServer{Name: "eventos", URL: events.URL, Headers: map[string]string{"X-API-Key": "k2"}},
		snapshot.WireMCPServer{Name: "sin-clave", URL: plain.URL, Headers: map[string]string{"X-API-Key": "otra"}},
		snapshot.WireMCPServer{Name: "caido", URL: "http://127.0.0.1:1/mcp"},
	)
	r := reporter(cp.URL, h)
	if err := r.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(*got) != 1 {
		t.Fatalf("reports = %d, want 1", len(*got))
	}
	rep := (*got)[0]
	if rep.InstanceID != "gw-1" || len(rep.Servers) != 4 {
		t.Fatalf("report = %+v", rep)
	}
	by := map[string]Server{}
	for _, s := range rep.Servers {
		by[s.Name] = s
	}
	for _, name := range []string{"demo", "eventos"} {
		s := by[name]
		if s.Error != "" || len(s.Tools) != 2 {
			t.Fatalf("%s = %+v", name, s)
		}
		// By name; the server's hint; the description trimmed and clipped.
		if s.Tools[0].Name != "borrar_todo" || s.Tools[0].ReadOnly || len([]rune(s.Tools[0].Description)) != maxDescription {
			t.Errorf("%s first tool = %+v", name, s.Tools[0])
		}
		if s.Tools[1] != (Tool{Name: "hora", Description: "La hora.", ReadOnly: true}) {
			t.Errorf("%s second tool = %+v", name, s.Tools[1])
		}
	}
	if e := by["sin-clave"].Error; e != "initialize: the server answered 401" {
		t.Errorf("wrong credential: %q", e)
	}
	if e := by["caido"].Error; !strings.HasPrefix(e, "initialize: the server could not be reached") || by["caido"].Tools == nil {
		t.Errorf("unreachable: %+v", by["caido"])
	}
	// The session: initialized, listed with its id, and closed.
	want := []string{"initialize ", "notifications/initialized s-1", "tools/list s-1", "DELETE s-1"}
	if strings.Join((*calls)[:4], ",") != strings.Join(want, ",") {
		t.Errorf("calls = %q", *calls)
	}
	for _, c := range *calls {
		if strings.HasPrefix(c, "tools/call") {
			t.Fatal("a tool was called")
		}
	}
}

func TestReportsAgainOnlyWhenTheServersChangeOrEveryPasses(t *testing.T) {
	plain, _ := mcpServer(t, false, false, "k1")
	cp, got := controlPlane(t, http.StatusOK)
	srv := snapshot.WireMCPServer{Name: "demo", URL: plain.URL, Headers: map[string]string{"X-API-Key": "k1"}}
	h := holderWith(srv)
	r := reporter(cp.URL, h)
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	r.now = func() time.Time { return now }
	ctx := context.Background()
	r.Once(ctx)
	r.Once(ctx)
	if len(*got) != 1 {
		t.Fatalf("same servers: reports = %d, want 1", len(*got))
	}
	// A new credential is a change.
	srv.Headers = map[string]string{"X-API-Key": "k1", "X-Other": "y"}
	st := &snapshot.State{Version: 2, MCP: []snapshot.WireMCPServer{srv}}
	h.Store(st, snapshot.Build(st, now))
	r.Once(ctx)
	if len(*got) != 2 {
		t.Fatalf("changed: reports = %d, want 2", len(*got))
	}
	now = now.Add(10 * time.Minute)
	r.Once(ctx)
	if len(*got) != 3 {
		t.Fatalf("after Every: reports = %d, want 3", len(*got))
	}
}

func TestAControlPlaneThatRefusesIsTriedAgain(t *testing.T) {
	plain, _ := mcpServer(t, false, false, "k1")
	cp, got := controlPlane(t, http.StatusServiceUnavailable)
	r := reporter(cp.URL, holderWith(snapshot.WireMCPServer{Name: "demo", URL: plain.URL, Headers: map[string]string{"X-API-Key": "k1"}}))
	if err := r.Once(context.Background()); err == nil {
		t.Fatal("want an error")
	}
	r.Once(context.Background())
	if len(*got) != 2 {
		t.Fatalf("reports = %d, want 2 (tried again)", len(*got))
	}
}
