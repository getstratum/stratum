package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// A small MCP server (Streamable HTTP, JSON answers) for the demo and tests
// of the gateway's MCP proxy (ADR-0016): three made-up tools.
//
//	POST /mcp   initialize, tools/list, tools/call; notifications get 202
//
// MOCK_MCP_TOKEN, when set, is the bearer token it requires, as a real
// server would: the gateway adds it, agents never see it.

// hora and clima say they only read (MCP's readOnlyHint): an application
// such as the Enterprise portal calls them without asking the person;
// borrar_todo says it destroys.
var mcpTools = []map[string]any{
	{"name": "hora", "description": "La hora actual, en UTC.",
		"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		"annotations": map[string]any{"readOnlyHint": true}},
	{"name": "clima", "description": "El clima de una ciudad (inventado, para la demo).",
		"inputSchema": map[string]any{"type": "object", "properties": map[string]any{"ciudad": map[string]any{"type": "string"}}, "required": []string{"ciudad"}},
		"annotations": map[string]any{"readOnlyHint": true}},
	{"name": "borrar_todo", "description": "Borra todos los registros. Peligrosa: para mostrar que la política la frena.",
		"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		"annotations": map[string]any{"readOnlyHint": false, "destructiveHint": true}},
}

func mcp(w http.ResponseWriter, r *http.Request) {
	if token := os.Getenv("MOCK_MCP_TOKEN"); token != "" && r.Header.Get("Authorization") != "Bearer "+token {
		w.Header().Set("WWW-Authenticate", `Bearer realm="mock-mcp"`)
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	var m struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		} `json:"params"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&m); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	if len(m.ID) == 0 { // a notification
		w.WriteHeader(http.StatusAccepted)
		return
	}
	var result any
	var rpcErr any
	switch m.Method {
	case "initialize":
		w.Header().Set("Mcp-Session-Id", fmt.Sprintf("mock-%d", time.Now().UnixNano()))
		result = map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{"tools": map[string]any{}},
			"serverInfo": map[string]any{"name": "mock-mcp", "version": "1.0.0"}}
	case "ping":
		result = map[string]any{}
	case "tools/list":
		result = map[string]any{"tools": mcpTools}
	case "tools/call":
		text := ""
		switch m.Params.Name {
		case "hora":
			text = "Son las " + time.Now().UTC().Format("15:04") + " UTC."
		case "clima":
			city, _ := m.Params.Arguments["ciudad"].(string)
			if strings.TrimSpace(city) == "" {
				city = "Montevideo"
			}
			text = "En " + city + ": 21 °C, parcialmente nublado (dato inventado)."
		case "borrar_todo":
			text = "Se borraron todos los registros (simulado: no había nada)."
		default:
			rpcErr = map[string]any{"code": -32602, "message": "unknown tool " + m.Params.Name}
		}
		if rpcErr == nil {
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}}
		}
	default:
		rpcErr = map[string]any{"code": -32601, "message": "method not found: " + m.Method}
	}
	out := map[string]any{"jsonrpc": "2.0", "id": m.ID}
	if rpcErr != nil {
		out["error"] = rpcErr
	} else {
		out["result"] = result
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}
