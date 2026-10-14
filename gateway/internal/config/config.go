// Package config reads gateway settings from STRATUM_* environment variables
// and validates them up front, so a misconfigured gateway fails at boot
// instead of on the first request.
package config

import (
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/getstratum/stratum/gateway/internal/valkey"
)

// Mode is where the gateway gets its configuration from.
type Mode string

const (
	// ModeControlPlane pulls configuration from a Stratum control plane.
	ModeControlPlane Mode = "control-plane"
	// ModeStatic reads configuration from a local file (GitOps, no control plane).
	ModeStatic Mode = "static"
)

type Config struct {
	Mode Mode

	ListenAddr string // public traffic + /livez + /readyz
	AdminAddr  string // /metrics, /livez, /readyz; empty disables

	// Control plane mode
	CPURL              string
	SyncToken          string
	InstanceID         string
	SyncInterval       time.Duration
	FullResyncInterval time.Duration

	// Static mode
	ConfigFile string

	// Snapshot persistence (cold start without a control plane)
	SnapshotPath         string
	SnapshotKey          []byte // 32 bytes; persistence is off when nil
	SnapshotMaxDropRatio float64
	SnapshotGuardMinKeys int
	// Shared copy of the snapshot in Valkey (ADR-0008). On when Valkey and
	// the snapshot key are both configured, unless STRATUM_SNAPSHOT_SHARED=false.
	SnapshotShared           bool
	SnapshotBootstrapTimeout time.Duration // wait for the control plane before using the shared copy

	// Request path
	MaxInflight           int
	MaxRequestBytes       int64
	UpstreamHeaderTimeout time.Duration // time to first byte from the provider
	StreamIdleTimeout     time.Duration // max silence between upstream chunks
	PIIEnabled            bool
	CORSAllowedOrigins    []string

	// Shared quota store (optional). Empty ValkeyURL means local counters.
	ValkeyURL         string
	ValkeyPassword    string // overrides the password in ValkeyURL
	ValkeyKeyPrefix   string
	QuotaSyncInterval time.Duration
	QuotaStaleAfter   time.Duration
	QuotaFailClosed   bool

	// Lifecycle
	DrainDelay      time.Duration // readiness fails this long before we stop accepting
	ShutdownTimeout time.Duration // max wait for in-flight requests (streams) to finish

	LogLevel string
}

// FromEnv builds a Config from the process environment.
func FromEnv() (*Config, error) { return Load(os.Getenv) }

// Load builds a Config from an environment lookup function.
func Load(getenv func(string) string) (*Config, error) {
	e := &env{get: getenv}
	c := &Config{
		ListenAddr: e.str("STRATUM_LISTEN_ADDR", ":20128"),
		AdminAddr:  e.str("STRATUM_ADMIN_ADDR", ":9090"),

		CPURL:              strings.TrimRight(e.str("STRATUM_CP_URL", ""), "/"),
		SyncToken:          e.str("STRATUM_SYNC_TOKEN", ""),
		InstanceID:         e.str("STRATUM_INSTANCE_ID", ""),
		SyncInterval:       e.dur("STRATUM_SYNC_INTERVAL", 30*time.Second),
		FullResyncInterval: e.dur("STRATUM_FULL_RESYNC_INTERVAL", 10*time.Minute),

		ConfigFile: e.str("STRATUM_CONFIG_FILE", ""),

		SnapshotPath:             e.str("STRATUM_SNAPSHOT_PATH", "/var/lib/stratum/snapshot.bin"),
		SnapshotMaxDropRatio:     e.float("STRATUM_SNAPSHOT_MAX_DROP_RATIO", 0.5),
		SnapshotGuardMinKeys:     e.int("STRATUM_SNAPSHOT_GUARD_MIN_KEYS", 10),
		SnapshotShared:           e.bool("STRATUM_SNAPSHOT_SHARED", true),
		SnapshotBootstrapTimeout: e.dur("STRATUM_SNAPSHOT_BOOTSTRAP_TIMEOUT", 10*time.Second),

		MaxInflight:           e.int("STRATUM_MAX_INFLIGHT", 1024),
		MaxRequestBytes:       int64(e.int("STRATUM_MAX_REQUEST_BYTES", 10<<20)),
		UpstreamHeaderTimeout: e.dur("STRATUM_UPSTREAM_HEADER_TIMEOUT", 120*time.Second),
		StreamIdleTimeout:     e.dur("STRATUM_STREAM_IDLE_TIMEOUT", 60*time.Second),
		PIIEnabled:            e.bool("STRATUM_PII_ENABLED", true),
		CORSAllowedOrigins:    e.list("STRATUM_CORS_ALLOWED_ORIGINS"),

		ValkeyURL:         e.str("STRATUM_VALKEY_URL", ""),
		ValkeyPassword:    e.str("STRATUM_VALKEY_PASSWORD", ""),
		ValkeyKeyPrefix:   e.str("STRATUM_VALKEY_KEY_PREFIX", "stratum"),
		QuotaSyncInterval: e.dur("STRATUM_QUOTA_SYNC_INTERVAL", time.Second),
		QuotaStaleAfter:   e.dur("STRATUM_QUOTA_STALE_AFTER", 30*time.Second),

		DrainDelay:      e.dur("STRATUM_DRAIN_DELAY", 5*time.Second),
		ShutdownTimeout: e.dur("STRATUM_SHUTDOWN_TIMEOUT", 10*time.Minute),

		LogLevel: strings.ToLower(e.str("STRATUM_LOG_LEVEL", "info")),
	}

	if k := e.str("STRATUM_SNAPSHOT_KEY", ""); k != "" {
		key, err := hex.DecodeString(k)
		if err != nil || len(key) != 32 {
			e.fail("STRATUM_SNAPSHOT_KEY must be 64 hex characters (32 bytes); generate one with: openssl rand -hex 32")
		} else {
			c.SnapshotKey = key
		}
	}

	switch {
	case c.CPURL != "" && c.ConfigFile != "":
		e.fail("set either STRATUM_CP_URL or STRATUM_CONFIG_FILE, not both")
	case c.CPURL != "":
		c.Mode = ModeControlPlane
		c.validateControlPlane(e)
	case c.ConfigFile != "":
		c.Mode = ModeStatic
	default:
		e.fail("no configuration source: set STRATUM_CP_URL (control plane) or STRATUM_CONFIG_FILE (standalone)")
	}

	if c.MaxInflight < 1 {
		e.fail("STRATUM_MAX_INFLIGHT must be >= 1")
	}
	if c.MaxRequestBytes < 1024 {
		e.fail("STRATUM_MAX_REQUEST_BYTES must be >= 1024")
	}
	if c.SnapshotMaxDropRatio <= 0 || c.SnapshotMaxDropRatio > 1 {
		e.fail("STRATUM_SNAPSHOT_MAX_DROP_RATIO must be in (0, 1]")
	}
	switch mode := strings.ToLower(e.str("STRATUM_QUOTA_FAIL_MODE", "open")); mode {
	case "open":
	case "closed":
		c.QuotaFailClosed = true
	default:
		e.fail("STRATUM_QUOTA_FAIL_MODE must be open or closed")
	}
	if c.ValkeyURL != "" {
		if _, err := valkey.ParseURL(c.ValkeyURL); err != nil {
			// Never echo the URL: it may carry a password.
			e.fail("STRATUM_VALKEY_URL: " + err.Error())
		}
		if c.QuotaSyncInterval < 100*time.Millisecond || c.QuotaSyncInterval > time.Minute {
			e.fail("STRATUM_QUOTA_SYNC_INTERVAL must be between 100ms and 1m")
		}
		if c.QuotaStaleAfter < 2*c.QuotaSyncInterval {
			e.fail("STRATUM_QUOTA_STALE_AFTER must be at least twice STRATUM_QUOTA_SYNC_INTERVAL")
		}
	} else if c.QuotaFailClosed {
		e.fail("STRATUM_QUOTA_FAIL_MODE=closed needs STRATUM_VALKEY_URL")
	}
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		e.fail("STRATUM_LOG_LEVEL must be debug, info, warn or error")
	}

	if len(e.errs) > 0 {
		return nil, errors.Join(e.errs...)
	}
	return c, nil
}

func (c *Config) validateControlPlane(e *env) {
	u, err := url.Parse(c.CPURL)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		e.fail("STRATUM_CP_URL must be an absolute http(s) URL")
		return
	}
	// Provider credentials travel on this channel. Plain HTTP is only for
	// local development and has to be asked for explicitly.
	if u.Scheme == "http" && !e.bool("STRATUM_CP_ALLOW_HTTP", false) {
		e.fail("STRATUM_CP_URL uses plain http; provider keys travel on this channel. Use https, or set STRATUM_CP_ALLOW_HTTP=true for local development")
	}
	if c.SyncToken == "" {
		e.fail("STRATUM_SYNC_TOKEN is required with STRATUM_CP_URL")
	}
	if c.InstanceID == "" {
		e.fail("STRATUM_INSTANCE_ID is required with STRATUM_CP_URL")
	}
	if c.SnapshotBootstrapTimeout < 0 {
		e.fail("STRATUM_SNAPSHOT_BOOTSTRAP_TIMEOUT must not be negative")
	}
	if c.SyncInterval < time.Second {
		e.fail("STRATUM_SYNC_INTERVAL must be >= 1s")
	}
}

// PersistenceEnabled reports whether snapshots are written to disk.
func (c *Config) PersistenceEnabled() bool { return c.SnapshotKey != nil && c.SnapshotPath != "" }

// SharedSnapshotEnabled reports whether gateways keep an encrypted copy of
// the snapshot in Valkey and can start from it (ADR-0008).
func (c *Config) SharedSnapshotEnabled() bool {
	return c.Mode == ModeControlPlane && c.SnapshotShared && c.ValkeyURL != "" && c.SnapshotKey != nil
}

type env struct {
	get  func(string) string
	errs []error
}

func (e *env) fail(msg string) { e.errs = append(e.errs, errors.New(msg)) }

func (e *env) str(k, def string) string {
	if v := strings.TrimSpace(e.get(k)); v != "" {
		return v
	}
	return def
}

func (e *env) int(k string, def int) int {
	v := e.str(k, "")
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		e.fail(fmt.Sprintf("%s: %q is not an integer", k, v))
		return def
	}
	return n
}

func (e *env) float(k string, def float64) float64 {
	v := e.str(k, "")
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		e.fail(fmt.Sprintf("%s: %q is not a number", k, v))
		return def
	}
	return f
}

func (e *env) bool(k string, def bool) bool {
	v := e.str(k, "")
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		e.fail(fmt.Sprintf("%s: %q is not a boolean", k, v))
		return def
	}
	return b
}

// dur accepts Go durations ("30s", "10m") or a bare number of seconds.
func (e *env) dur(k string, def time.Duration) time.Duration {
	v := e.str(k, "")
	if v == "" {
		return def
	}
	if n, err := strconv.Atoi(v); err == nil {
		return time.Duration(n) * time.Second
	}
	d, err := time.ParseDuration(v)
	if err != nil || d < 0 {
		e.fail(fmt.Sprintf("%s: %q is not a duration (e.g. 30s, 5m)", k, v))
		return def
	}
	return d
}

func (e *env) list(k string) []string {
	var out []string
	for _, p := range strings.Split(e.str(k, ""), ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
