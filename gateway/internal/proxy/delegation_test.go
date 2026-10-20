package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/getstratum/stratum/gateway/internal/auth"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

const portalKey = "aig_agt_portal_delegates_000000"

// delegationEnv is newEnv with a configuration of its own: an application
// key that delegates (team "apps"), a developer key that does not (team
// t1), and three people in the directory.
func delegationEnv(t *testing.T) *env {
	t.Helper()
	var upURL string
	e := newEnv(t, allowAll, time.Minute, func(h *Handler) {
		// newEnv's provider configs point at its upstream; reuse that URL.
		prov, _ := h.Holder.Load().Provider("openai")
		upURL = prov.BaseURL
		syncJSON := fmt.Sprintf(`{
		  "current_version": 9,
		  "policies": [
		    {"id":"p_eng","team_id":"t1","version":1,"allow_all_models":true},
		    {"id":"p_mkt","team_id":"t2","version":1,"allowed_models":["gpt-4o-mini"],"monthly_token_quota":1000},
		    {"id":"p_apps","team_id":"apps","version":1,"allowed_models":["gpt-4.1-nano"]}
		  ],
		  "api_keys": [
		    {"id":"u1","key_hash":%q,"team_id":"t1","version":1,"revoked":false},
		    {"id":"agent:portal","key_hash":%q,"team_id":"apps","version":2,"revoked":false,"delegates":true}
		  ],
		  "people": [
		    {"id":"ana","team_id":"t2","version":3,"revoked":false},
		    {"id":"bruno","team_id":"t1","version":4,"revoked":false},
		    {"id":"carla","team_id":"t2","version":5,"revoked":true}
		  ],
		  "provider_configs": [
		    {"id":"oa","provider":"openai","api_key":"sk-up","base_url":%q,"enabled":true,"version":2,"revoked":false}
		  ]}`, auth.HashKey(devKey), auth.HashKey(portalKey), upURL)
		var resp snapshot.SyncResponse
		if err := json.Unmarshal([]byte(syncJSON), &resp); err != nil {
			t.Fatal(err)
		}
		st, err := (*snapshot.State)(nil).Apply(&resp, true)
		if err != nil {
			t.Fatal(err)
		}
		h.Holder = &snapshot.Holder{}
		h.Holder.Store(st, snapshot.Build(st, time.Now()))
	})
	return e
}

func (e *env) postAs(key, person, body string) *http.Response {
	e.t.Helper()
	req, _ := http.NewRequest(http.MethodPost, e.gw.URL+"/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+key)
	if person != "" {
		req.Header.Set("X-Stratum-User", person)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { res.Body.Close() })
	return res
}

func TestDelegationAppliesThePersonsPolicy(t *testing.T) {
	e := delegationEnv(t)

	// Ana is in t2: only gpt-4o-mini, whatever the portal's own team allows.
	if res := e.postAs(portalKey, "ana", `{"model":"openai/gpt-4o","messages":[]}`); res.StatusCode != 403 || errCode(t, res) != "model_not_allowed" {
		t.Fatalf("ana asking for gpt-4o: %d", res.StatusCode)
	}
	if res := e.postAs(portalKey, "ana", `{"model":"openai/gpt-4o-mini","messages":[]}`); res.StatusCode != 200 {
		t.Fatalf("ana asking for gpt-4o-mini: %d", res.StatusCode)
	}
	// Bruno is in t1, which allows every model.
	if res := e.postAs(portalKey, "bruno", `{"model":"openai/gpt-4o","messages":[]}`); res.StatusCode != 200 {
		t.Fatalf("bruno asking for gpt-4o: %d", res.StatusCode)
	}
	// Without the header the key is its own team's, like any agent.
	if res := e.postAs(portalKey, "", `{"model":"openai/gpt-4o-mini","messages":[]}`); res.StatusCode != 403 || errCode(t, res) != "model_not_allowed" {
		t.Fatalf("portal on its own: %d", res.StatusCode)
	}

	got := e.usage.wait(t, 4)
	if len(got) != 4 {
		t.Fatalf("%d records", len(got))
	}
	for i, want := range []struct{ user, team string }{{"ana", "t2"}, {"ana", "t2"}, {"bruno", "t1"}, {"", "apps"}} {
		if r := got[i]; r.KeyID != "agent:portal" || r.UserID != want.user || r.TeamID != want.team {
			t.Errorf("record %d = key %q user %q team %q, want user %q team %q", i, r.KeyID, r.UserID, r.TeamID, want.user, want.team)
		}
	}
	// Tokens count against the person's team, not the application's.
	if e.quota.Used("t2") != 18 || e.quota.Used("t1") != 18 || e.quota.Used("apps") != 0 {
		t.Errorf("quota t2=%d t1=%d apps=%d", e.quota.Used("t2"), e.quota.Used("t1"), e.quota.Used("apps"))
	}
}

func TestDelegationRefusals(t *testing.T) {
	e := delegationEnv(t)
	cases := []struct {
		name, key, person, code string
	}{
		{"a key that does not delegate", devKey, "ana", "delegation_not_allowed"},
		{"a person who is not in the directory", portalKey, "nobody", "unknown_user"},
		{"a person whose access was taken away", portalKey, "carla", "unknown_user"},
	}
	for _, c := range cases {
		res := e.postAs(c.key, c.person, `{"model":"openai/gpt-4o-mini","messages":[]}`)
		if res.StatusCode != 403 || errCode(t, res) != c.code {
			t.Errorf("%s: %d %s", c.name, res.StatusCode, c.code)
		}
	}
	e.up.mu.Lock()
	reached := e.up.path != ""
	e.up.mu.Unlock()
	if reached {
		t.Error("a refused request reached the provider")
	}
	// Refusals are reported under the key, without a person.
	for _, r := range e.usage.wait(t, 3) {
		if r.UserID != "" || r.Status != 403 {
			t.Errorf("refused record = %+v", r)
		}
	}
}

func TestDelegationFollowsTheDirectory(t *testing.T) {
	e := delegationEnv(t)
	if res := e.postAs(portalKey, "ana", `{"model":"openai/gpt-4o-mini","messages":[]}`); res.StatusCode != 200 {
		t.Fatalf("before: %d", res.StatusCode)
	}
	// The console takes Ana's access away: the next delta revokes her.
	h := e.gw.Config.Handler.(*Handler)
	st, err := h.Holder.State().Apply(&snapshot.SyncResponse{CurrentVersion: 10,
		People: []snapshot.WirePerson{{ID: "ana", TeamID: "t2", Version: 10, Revoked: true}}}, false)
	if err != nil {
		t.Fatal(err)
	}
	h.Holder.Store(st, snapshot.Build(st, time.Now()))
	if res := e.postAs(portalKey, "ana", `{"model":"openai/gpt-4o-mini","messages":[]}`); res.StatusCode != 403 || errCode(t, res) != "unknown_user" {
		t.Fatalf("after: %d", res.StatusCode)
	}
}
