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
