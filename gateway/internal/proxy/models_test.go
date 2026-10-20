package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/auth"
	"github.com/getstratum/stratum/gateway/internal/metrics"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

const (
	listKey   = "aig_sk_models_list_000000000000"
	appKey    = "aig_agt_models_app_000000000000"
	fixedKey  = "aig_agt_models_fixed_0000000000"
	strayKey  = "aig_sk_models_no_policy_0000000"
	modelsOrg = `[
	  {"provider":"openai","id":"gpt-4o","name":"GPT-4o"},
	  {"provider":"openai","id":"gpt-4o-mini","name":"GPT-4o mini"},
	  {"provider":"openai","id":"o3","name":"o3"},
	  {"provider":"anthropic","id":"claude-haiku-4-5","name":"Claude Haiku 4.5"},
	  {"provider":"mistral","id":"mistral-large","name":"Mistral Large"}
	]`
)

func modelsHandler(t *testing.T, models string) *Handler {
	t.Helper()
	field := ""
	if models != "" {
		field = `"models": ` + models + `,`
	}
	raw := fmt.Sprintf(`{
	  "current_version": 5, %s
	  "policies": [
	    {"id":"p1","team_id":"t1","version":1,"allow_all_models":true,"denied_models":["o3","openai/o3"]},
	    {"id":"p2","team_id":"t2","version":1,"allowed_models":["gpt-4o-mini","openai/gpt-4o-mini","anthropic/claude-haiku-4-5"]},
	    {"id":"p3","team_id":"t3","version":1,"allow_all_models":true,"allowed_providers":["anthropic"]}
	  ],
	  "api_keys": [
	    {"id":"u1","key_hash":%q,"team_id":"t1","version":1,"revoked":false},
	    {"id":"agent:app","key_hash":%q,"team_id":"t3","version":1,"revoked":false,"delegates":true},
	    {"id":"agent:fixed","key_hash":%q,"team_id":"t1","version":1,"revoked":false,"default_provider":"openai","default_model":"gpt-4o-mini"},
	    {"id":"u9","key_hash":%q,"team_id":"t9","version":1,"revoked":false}
	  ],
	  "people": [{"id":"ana","team_id":"t2","version":1,"revoked":false}],
	  "provider_configs": [
	    {"id":"oa","provider":"openai","api_key":"k","base_url":"http://127.0.0.1:1","enabled":true,"version":1,"revoked":false},
	    {"id":"an","provider":"anthropic","api_key":"k","base_url":"http://127.0.0.1:1","enabled":true,"version":1,"revoked":false}
	  ]}`, field, auth.HashKey(listKey), auth.HashKey(appKey), auth.HashKey(fixedKey), auth.HashKey(strayKey))
	var resp snapshot.SyncResponse
	if err := json.Unmarshal([]byte(raw), &resp); err != nil {
		t.Fatal(err)
	}
	st, err := (*snapshot.State)(nil).Apply(&resp, true)
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{Holder: &snapshot.Holder{}, Metrics: metrics.New(), Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	h.Holder.Store(st, snapshot.Build(st, time.Now()))
	return h
}

func listModels(t *testing.T, h *Handler, key, person string) (int, []string, map[string]string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+key)
	if person != "" {
		req.Header.Set("X-Stratum-User", person)
	}
	w := httptest.NewRecorder()
	h.Models(w, req)
	var body struct {
		Object string `json:"object"`
		Data   []struct {
			ID, Object, OwnedBy, Name string
		} `json:"data"`
		Error struct{ Code string } `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("%s: %v", w.Body, err)
	}
	if w.Code != 200 {
		return w.Code, []string{body.Error.Code}, nil
	}
	if body.Object != "list" {
		t.Fatalf("object = %q", body.Object)
	}
	ids, names := []string{}, map[string]string{}
	for _, m := range body.Data {
		if m.Object != "model" {
			t.Fatalf("entry %+v", m)
		}
		ids = append(ids, m.ID)
		names[m.ID] = m.Name
	}
	return w.Code, ids, names
}

func TestModelsFollowThePolicy(t *testing.T) {
	h := modelsHandler(t, modelsOrg)
	cases := []struct {
		name, key, person string
		want              []string
	}{
		// Every model of a configured provider, minus the one turned off;
		// mistral is in the catalog but not configured.
		{"all models", listKey, "", []string{"anthropic/claude-haiku-4-5", "openai/gpt-4o", "openai/gpt-4o-mini"}},
		{"one provider", appKey, "", []string{"anthropic/claude-haiku-4-5"}},
		{"a person's policy", appKey, "ana", []string{"anthropic/claude-haiku-4-5", "openai/gpt-4o-mini"}},
		{"a fixed model", fixedKey, "", []string{"openai/gpt-4o-mini"}},
	}
	for _, c := range cases {
		code, ids, names := listModels(t, h, c.key, c.person)
		if code != 200 || !slices.Equal(ids, c.want) {
			t.Errorf("%s: %d %v, want %v", c.name, code, ids, c.want)
		}
		if code == 200 && names["openai/gpt-4o-mini"] != "" && names["openai/gpt-4o-mini"] != "GPT-4o mini" {
			t.Errorf("%s: names %v", c.name, names)
		}
	}
}

func TestModelsRefusals(t *testing.T) {
	h := modelsHandler(t, modelsOrg)
	for _, c := range []struct {
		name, key, person string
		status            int
		code              string
	}{
		{"no key", "", "", 401, "missing_api_key"},
		{"bad key", "nope", "", 401, "invalid_api_key"},
		{"no policy", strayKey, "", 403, "no_policy"},
		{"not a delegating key", listKey, "ana", 403, "delegation_not_allowed"},
		{"unknown person", appKey, "bruno", 403, "unknown_user"},
	} {
		code, got, _ := listModels(t, h, c.key, c.person)
		if code != c.status || got[0] != c.code {
			t.Errorf("%s: %d %v", c.name, code, got)
		}
	}
}

func TestModelsWithoutAListFromTheControlPlane(t *testing.T) {
	h := modelsHandler(t, "")
	// Only what the policy names as provider/model: an "all models" policy
	// has nothing to list.
	if _, ids, _ := listModels(t, h, appKey, "ana"); !slices.Equal(ids, []string{"anthropic/claude-haiku-4-5", "openai/gpt-4o-mini"}) {
		t.Errorf("person: %v", ids)
	}
	if _, ids, _ := listModels(t, h, listKey, ""); len(ids) != 0 {
		t.Errorf("all models: %v", ids)
	}
}

func TestModelsListSurvivesDeltasWithoutIt(t *testing.T) {
	h := modelsHandler(t, modelsOrg)
	st, err := h.Holder.State().Apply(&snapshot.SyncResponse{CurrentVersion: 6}, false)
	if err != nil {
		t.Fatal(err)
	}
	h.Holder.Store(st, snapshot.Build(st, time.Now()))
	if _, ids, _ := listModels(t, h, listKey, ""); len(ids) != 3 {
		t.Errorf("after a delta without models: %v", ids)
	}
	st, _ = st.Apply(&snapshot.SyncResponse{CurrentVersion: 7, Models: []snapshot.WireModel{{Provider: "openai", ID: "gpt-4o"}}}, false)
	h.Holder.Store(st, snapshot.Build(st, time.Now()))
	if _, ids, _ := listModels(t, h, listKey, ""); !slices.Equal(ids, []string{"openai/gpt-4o"}) {
		t.Errorf("a new list replaces the old one: %v", ids)
	}
}
