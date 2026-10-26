package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/auth"
	"github.com/getstratum/stratum/gateway/internal/provider"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

const teamSays = "Si falta contexto, preguntá antes de responder."

func TestAddInstructions(t *testing.T) {
	cases := []struct {
		name, path string
		kind       provider.Kind
		body       string
		field      string
		want       any // the field after; nil = must be left as it was
	}{
		{"chat: first message", "v1/chat/completions", provider.KindOpenAI,
			`{"messages":[{"role":"system","content":"Sé breve."},{"role":"user","content":"hola"}]}`, "messages",
			[]any{map[string]any{"role": "system", "content": teamSays}, map[string]any{"role": "system", "content": "Sé breve."}, map[string]any{"role": "user", "content": "hola"}}},
		{"chat to Anthropic, OpenAI format", "v1/chat/completions", provider.KindAnthropic,
			`{"messages":[{"role":"user","content":"hola"}]}`, "messages",
			[]any{map[string]any{"role": "system", "content": teamSays}, map[string]any{"role": "user", "content": "hola"}}},
		{"chat through Azure", "openai/deployments/x/chat/completions", provider.KindAzure,
			`{"messages":[]}`, "messages", []any{map[string]any{"role": "system", "content": teamSays}}},
		{"anthropic: no system", "v1/messages", provider.KindAnthropic, `{"messages":[]}`, "system", teamSays},
		{"anthropic: system text", "v1/messages", provider.KindAnthropic, `{"system":"Sé breve.","messages":[]}`, "system", teamSays + "\n\nSé breve."},
		{"anthropic: system blocks keep their cache_control", "v1/messages", provider.KindAnthropic,
			`{"system":[{"type":"text","text":"Sé breve.","cache_control":{"type":"ephemeral"}}],"messages":[]}`, "system",
			[]any{map[string]any{"type": "text", "text": teamSays}, map[string]any{"type": "text", "text": "Sé breve.", "cache_control": map[string]any{"type": "ephemeral"}}}},
		{"responses: instructions", "v1/responses", provider.KindOpenAI, `{"instructions":"Sé breve.","input":"hola"}`, "instructions", teamSays + "\n\nSé breve."},
		{"responses: none", "v1/responses", provider.KindOpenAI, `{"input":"hola"}`, "instructions", teamSays},
		{"legacy completions untouched", "v1/completions", provider.KindOpenAI, `{"prompt":"hola"}`, "prompt", nil},
		{"embeddings untouched", "v1/embeddings", provider.KindOpenAI, `{"input":"hola"}`, "input", nil},
		{"count_tokens untouched", "v1/messages/count_tokens", provider.KindAnthropic, `{"messages":[]}`, "system", nil},
		{"chat without messages untouched", "v1/chat/completions", provider.KindOpenAI, `{"messages":"x"}`, "messages", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			body, err := decodeObject([]byte(c.body))
			if err != nil {
				t.Fatal(err)
			}
			before, _ := json.Marshal(body)
			changed := addInstructions(body, c.path, c.kind, teamSays)
			if changed != (c.want != nil) {
				t.Fatalf("changed = %v", changed)
			}
			if c.want == nil {
				if after, _ := json.Marshal(body); string(after) != string(before) {
					t.Fatalf("body changed: %s", after)
				}
				return
			}
			got, _ := json.Marshal(body[c.field])
			want, _ := json.Marshal(c.want)
			var g, w any
			json.Unmarshal(got, &g)
			json.Unmarshal(want, &w)
			if !reflect.DeepEqual(g, w) {
				t.Errorf("%s = %s\nwant %s", c.field, got, want)
			}
		})
	}
}

// instructionsEnv: team t2 has instructions for people, team t1 does not;
// the portal's key delegates, the developer key (t1) does not.
func instructionsEnv(t *testing.T, devTeamInstructions bool) *env {
	t.Helper()
	return newEnv(t, allowAll, time.Minute, func(h *Handler) {
		prov, _ := h.Holder.Load().Provider("openai")
		t1 := ""
		if devTeamInstructions {
			t1 = fmt.Sprintf(`,"people_instructions":%q`, teamSays)
		}
		raw := fmt.Sprintf(`{
		  "current_version": 9,
		  "policies": [
		    {"id":"p1","team_id":"t1","version":1,"allow_all_models":true%s},
		    {"id":"p2","team_id":"t2","version":1,"allow_all_models":true,"people_instructions":%q},
		    {"id":"pa","team_id":"apps","version":1,"allow_all_models":true}
		  ],
		  "api_keys": [
		    {"id":"u1","key_hash":%q,"team_id":"t1","version":1,"revoked":false},
		    {"id":"agent:portal","key_hash":%q,"team_id":"apps","version":2,"revoked":false,"delegates":true}
		  ],
		  "people": [
		    {"id":"ana","team_id":"t2","version":3,"revoked":false},
		    {"id":"bruno","team_id":"t1","version":4,"revoked":false}
		  ],
		  "provider_configs": [
		    {"id":"oa","provider":"openai","api_key":"sk-up","base_url":%q,"enabled":true,"version":2,"revoked":false}
		  ]}`, t1, "  "+teamSays+"\n", auth.HashKey(devKey), auth.HashKey(portalKey), prov.BaseURL)
		var resp snapshot.SyncResponse
		if err := json.Unmarshal([]byte(raw), &resp); err != nil {
			t.Fatal(err)
		}
		st, err := (*snapshot.State)(nil).Apply(&resp, true)
		if err != nil {
			t.Fatal(err)
		}
		h.Holder = &snapshot.Holder{}
		h.Holder.Store(st, snapshot.Build(st, time.Now()))
	})
}

func firstMessage(t *testing.T, e *env) map[string]any {
	t.Helper()
	e.up.mu.Lock()
	defer e.up.mu.Unlock()
	msgs, _ := e.up.body["messages"].([]any)
	if len(msgs) == 0 {
		return nil
	}
	m, _ := msgs[0].(map[string]any)
	return m
}

func TestInstructionsOnlyForPeople(t *testing.T) {
	e := instructionsEnv(t, true)
	body := `{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hola"}]}`

	// Ana, through the portal: her team's instructions go first, trimmed.
	res := e.postAs(portalKey, "ana", body)
	if res.StatusCode != 200 {
		t.Fatalf("ana: %d", res.StatusCode)
	}
	if m := firstMessage(t, e); m["role"] != "system" || m["content"] != teamSays {
		t.Fatalf("ana's request: first message %v", m)
	}
	if got := res.Header.Get("X-Stratum-Instructions"); got != instructionsID(teamSays) {
		t.Errorf("X-Stratum-Instructions = %q", got)
	}

	// The developer's own key, in a team that has instructions: none.
	res = e.postAs(devKey, "", body)
	if m := firstMessage(t, e); res.StatusCode != 200 || m["role"] != "user" {
		t.Fatalf("developer key: %d, first message %v", res.StatusCode, m)
	}
	if res.Header.Get("X-Stratum-Instructions") != "" {
		t.Error("a key's own request says it got instructions")
	}

	// The portal's key on its own (no person): none either.
	res = e.postAs(portalKey, "", body)
	if m := firstMessage(t, e); res.StatusCode != 200 || m["role"] != "user" {
		t.Fatalf("portal on its own: %d, first message %v", res.StatusCode, m)
	}
}

func TestInstructionsEndpoint(t *testing.T) {
	e := instructionsEnv(t, false)
	srv := httptest.NewServer(http.HandlerFunc(e.h.Instructions))
	defer srv.Close()

	get := func(key, person string) (int, map[string]any) {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+"/v1/stratum/instructions", nil)
		req.Header.Set("Authorization", "Bearer "+key)
		if person != "" {
			req.Header.Set("X-Stratum-User", person)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	if code, out := get(portalKey, "ana"); code != 200 || out["instructions"] != teamSays || out["id"] != instructionsID(teamSays) {
		t.Errorf("ana: %d %v", code, out)
	}
	if code, out := get(portalKey, "bruno"); code != 200 || out["instructions"] != nil {
		t.Errorf("bruno (team without instructions): %d %v", code, out)
	}
	if code, out := get(devKey, ""); code != 200 || out["instructions"] != nil {
		t.Errorf("a key's own: %d %v", code, out)
	}
	if code, _ := get(portalKey, "nobody"); code != 403 {
		t.Errorf("someone not in the directory: %d", code)
	}
}
