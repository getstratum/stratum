package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A policy's default model (migration 039 of the control plane).

func TestARequestWithoutAModelGoesToThePolicysDefault(t *testing.T) {
	toRoute := `{"id":"p","team_id":"t1","version":1,"allow_all_models":true,"default_model":"stratum/rapido","pii_action":"redact","dlp_action":"block"}`
	e := newEnv(t, toRoute, time.Minute)
	up2 := withAliases(t, e, rapido)
	res := e.post("/v1/chat/completions", devKey, `{"messages":[{"role":"user","content":"hola"}]}`)
	if res.StatusCode != 200 || res.Header.Get("X-Stratum-Routed-To") != "openai/gpt-4o-mini" || e.up.body["model"] != "gpt-4o-mini" {
		t.Fatalf("status %d, routed to %q, body model %v", res.StatusCode, res.Header.Get("X-Stratum-Routed-To"), e.up.body["model"])
	}
	if got := e.usage.wait(t, 1); got[0].Alias != "rapido" {
		t.Errorf("usage alias %q", got[0].Alias)
	}

	// A model named in the request wins.
	if res := e.post("/v1/chat/completions", devKey, `{"model":"groq/llama-3.3-70b"}`); res.StatusCode != 200 || up2.body["model"] != "llama-3.3-70b" {
		t.Errorf("named model: %d %v", res.StatusCode, up2.body)
	}
	// An agent's fixed model wins too.
	e.up.body = nil
	if res := e.post("/v1/chat/completions", agentKey, `{}`); res.StatusCode != 200 || e.up.body["model"] != "gpt-4o-mini" {
		t.Errorf("agent: %d %v", res.StatusCode, e.up.body)
	}
}

func TestAPlainDefaultModel(t *testing.T) {
	toModel := `{"id":"p","team_id":"t1","version":1,"allow_all_models":true,"default_model":"openai/o3","pii_action":"redact","dlp_action":"block"}`
	e := newEnv(t, toModel, time.Minute)
	if res := e.post("/v1/chat/completions", devKey, `{"messages":[]}`); res.StatusCode != 200 || e.up.body["model"] != "o3" {
		t.Fatalf("status %d, body model %v", res.StatusCode, e.up.body["model"])
	}
}

func TestModelsMarkThePolicysDefault(t *testing.T) {
	toRoute := `{"id":"p","team_id":"t1","version":1,"allow_all_models":true,"default_model":"stratum/rapido","pii_action":"redact","dlp_action":"block"}`
	e := newEnv(t, toRoute, time.Minute)
	withAliases(t, e, rapido)
	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+devKey)
	w := httptest.NewRecorder()
	e.h.Models(w, req)
	var body struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	marked := []string{}
	for _, m := range body.Data {
		if m["default"] == true {
			marked = append(marked, m["id"].(string))
		}
	}
	if len(marked) != 1 || marked[0] != "stratum/rapido" {
		t.Errorf("marked as default: %v in %s", marked, w.Body)
	}
}

func TestARouteFallsBackWhenItsModelIsNotAtTheProvider(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	up2 := withAliases(t, e, rapido)
	e.up.handler = func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, `{"error":{"code":"model_not_found","message":"The model does not exist"}}`)
	}
	res := e.post("/v1/chat/completions", devKey, `{"model":"stratum/rapido"}`)
	if res.StatusCode != 200 || res.Header.Get("X-Stratum-Routed-To") != "groq/llama-3.3-70b" || up2.body["model"] != "llama-3.3-70b" {
		t.Fatalf("status %d, routed to %q", res.StatusCode, res.Header.Get("X-Stratum-Routed-To"))
	}
}
