package config

import (
	"strings"
	"testing"
	"time"
)

func envOf(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestControlPlaneMode(t *testing.T) {
	c, err := Load(envOf(map[string]string{
		"STRATUM_CP_URL":        "https://cp.example.com/",
		"STRATUM_SYNC_TOKEN":    "dp_sync_x",
		"STRATUM_INSTANCE_ID":   "dp_1",
		"STRATUM_SYNC_INTERVAL": "15",
		"STRATUM_SNAPSHOT_KEY":  strings.Repeat("ab", 32),
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Mode != ModeControlPlane || c.CPURL != "https://cp.example.com" {
		t.Fatalf("mode/url: %+v", c)
	}
	if c.SyncInterval != 15*time.Second {
		t.Fatalf("bare seconds not accepted: %v", c.SyncInterval)
	}
	if !c.PersistenceEnabled() {
		t.Fatal("persistence should be on with a key")
	}
}

func TestPlainHTTPControlPlaneNeedsOptIn(t *testing.T) {
	base := map[string]string{
		"STRATUM_CP_URL":      "http://cp:3000",
		"STRATUM_SYNC_TOKEN":  "t",
		"STRATUM_INSTANCE_ID": "i",
	}
	if _, err := Load(envOf(base)); err == nil || !strings.Contains(err.Error(), "plain http") {
		t.Fatalf("expected plain-http rejection, got %v", err)
	}
	base["STRATUM_CP_ALLOW_HTTP"] = "true"
	if _, err := Load(envOf(base)); err != nil {
		t.Fatal(err)
	}
}

func TestReportsEveryProblemAtOnce(t *testing.T) {
	_, err := Load(envOf(map[string]string{
		"STRATUM_CP_URL":       "https://cp",
		"STRATUM_SNAPSHOT_KEY": "short",
		"STRATUM_MAX_INFLIGHT": "zero",
	}))
	if err == nil {
		t.Fatal("expected errors")
	}
	for _, want := range []string{"SYNC_TOKEN", "INSTANCE_ID", "SNAPSHOT_KEY", "MAX_INFLIGHT"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %s: %v", want, err)
		}
	}
}

func TestNeedsExactlyOneSource(t *testing.T) {
	if _, err := Load(envOf(nil)); err == nil {
		t.Fatal("no source must fail")
	}
	if _, err := Load(envOf(map[string]string{
		"STRATUM_CP_URL": "https://cp", "STRATUM_CONFIG_FILE": "/etc/stratum.json",
	})); err == nil {
		t.Fatal("two sources must fail")
	}
	c, err := Load(envOf(map[string]string{"STRATUM_CONFIG_FILE": "/etc/stratum.json"}))
	if err != nil || c.Mode != ModeStatic {
		t.Fatalf("static mode: %v %+v", err, c)
	}
	if c.PersistenceEnabled() {
		t.Fatal("persistence must be off without a key")
	}
}

func TestSharedQuotaSettings(t *testing.T) {
	base := func(extra map[string]string) map[string]string {
		m := map[string]string{"STRATUM_CONFIG_FILE": "/etc/stratum/stratum.json"}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}

	c, err := Load(envOf(base(nil)))
	if err != nil || c.ValkeyURL != "" || c.QuotaFailClosed {
		t.Fatalf("default must be local quotas, fail open: %+v %v", c, err)
	}

	c, err = Load(envOf(base(map[string]string{
		"STRATUM_VALKEY_URL":        "rediss://:pw@cache:6380/1",
		"STRATUM_QUOTA_FAIL_MODE":   "closed",
		"STRATUM_QUOTA_STALE_AFTER": "10s",
	})))
	if err != nil {
		t.Fatal(err)
	}
	if !c.QuotaFailClosed || c.QuotaSyncInterval != time.Second || c.QuotaStaleAfter != 10*time.Second {
		t.Fatalf("got %+v", c)
	}

	for name, env := range map[string]map[string]string{
		"bad scheme":            {"STRATUM_VALKEY_URL": "http://user:hunter2@cache"},
		"bad fail mode":         {"STRATUM_VALKEY_URL": "redis://cache", "STRATUM_QUOTA_FAIL_MODE": "maybe"},
		"closed without valkey": {"STRATUM_QUOTA_FAIL_MODE": "closed"},
		"interval too short":    {"STRATUM_VALKEY_URL": "redis://cache", "STRATUM_QUOTA_SYNC_INTERVAL": "10ms"},
		"stale below 2x":        {"STRATUM_VALKEY_URL": "redis://cache", "STRATUM_QUOTA_STALE_AFTER": "1s"},
	} {
		_, err := Load(envOf(base(env)))
		if err == nil {
			t.Errorf("%s: expected an error", name)
			continue
		}
		if strings.Contains(err.Error(), "hunter2") {
			t.Errorf("%s: error leaks the password: %v", name, err)
		}
	}
}

func TestSharedSnapshotSettings(t *testing.T) {
	base := func() map[string]string {
		return map[string]string{
			"STRATUM_CP_URL":       "https://cp.example.com",
			"STRATUM_SYNC_TOKEN":   "t",
			"STRATUM_INSTANCE_ID":  "dp_1",
			"STRATUM_VALKEY_URL":   "redis://valkey:6379/0",
			"STRATUM_SNAPSHOT_KEY": strings.Repeat("ab", 32),
		}
	}
	c, err := Load(envOf(base()))
	if err != nil {
		t.Fatal(err)
	}
	if !c.SharedSnapshotEnabled() || c.SnapshotBootstrapTimeout != 10*time.Second {
		t.Fatalf("Valkey + snapshot key should share the snapshot by default: %+v", c)
	}

	for name, change := range map[string]func(map[string]string){
		"opt-out":   func(m map[string]string) { m["STRATUM_SNAPSHOT_SHARED"] = "false" },
		"no Valkey": func(m map[string]string) { delete(m, "STRATUM_VALKEY_URL") },
		"no key":    func(m map[string]string) { delete(m, "STRATUM_SNAPSHOT_KEY") },
	} {
		m := base()
		change(m)
		c, err := Load(envOf(m))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if c.SharedSnapshotEnabled() {
			t.Fatalf("%s: shared snapshot should be off", name)
		}
	}

	m := base()
	m["STRATUM_SNAPSHOT_BOOTSTRAP_TIMEOUT"] = "-1s"
	if _, err := Load(envOf(m)); err == nil {
		t.Fatal("negative bootstrap timeout must be rejected")
	}
}
