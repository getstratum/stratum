// Command stratum-gateway is the Stratum data plane: an OpenAI- and
// Anthropic-compatible proxy that authenticates developers, enforces team
// policies and scans prompts before they leave the customer's network.
//
// Usage:
//
//	stratum-gateway                 serve (default)
//	stratum-gateway healthcheck     exit 0 if the local gateway is ready
//	stratum-gateway hash-key [key]  print the SHA-256 of an API key (reads stdin if omitted)
//	stratum-gateway version         print version information
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"github.com/getstratum/stratum/gateway/internal/auth"
	"github.com/getstratum/stratum/gateway/internal/config"
	"github.com/getstratum/stratum/gateway/internal/health"
	"github.com/getstratum/stratum/gateway/internal/metrics"
	"github.com/getstratum/stratum/gateway/internal/proxy"
	"github.com/getstratum/stratum/gateway/internal/quota"
	"github.com/getstratum/stratum/gateway/internal/resilience"
	"github.com/getstratum/stratum/gateway/internal/server"
	"github.com/getstratum/stratum/gateway/internal/snapshot"
	"github.com/getstratum/stratum/gateway/internal/snapstore"
	"github.com/getstratum/stratum/gateway/internal/syncer"
	"github.com/getstratum/stratum/gateway/internal/usage"
	"github.com/getstratum/stratum/gateway/internal/valkey"
)

// Set at build time with -ldflags "-X main.version=... -X main.commit=...".
var (
	version = "dev"
	commit  = ""
)

func main() { os.Exit(run(os.Args[1:])) }

func run(args []string) int {
	cmd := "serve"
	if len(args) > 0 {
		cmd = args[0]
	}
	switch cmd {
	case "serve":
		return serve()
	case "healthcheck":
		return healthcheck()
	case "hash-key":
		return hashKey(args[1:])
	case "version", "--version", "-v":
		fmt.Printf("stratum-gateway %s (%s)\n", version, revision())
		return 0
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q (serve, healthcheck, hash-key, version)\n", cmd)
		return 2
	}
}

func serve() int {
	cfg, err := config.FromEnv()
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid configuration:\n%v\n", err)
		return 2
	}
	log := newLogger(cfg.LogLevel)
	log.Info("starting stratum-gateway", "version", version, "revision", revision(), "mode", cfg.Mode)

	m := metrics.New()
	holder := &snapshot.Holder{}
	hc := &health.Health{Holder: holder, Version: version}
	ctx, stopBackground := context.WithCancel(context.Background())
	defer stopBackground()

	// 1. Cold start from the last snapshot on disk, so the gateway can serve
	//    even if the control plane is unreachable right now.
	if cfg.Mode == config.ModeControlPlane {
		if cfg.PersistenceEnabled() {
			restoreSnapshot(cfg, holder, m, log)
		} else {
			log.Warn("STRATUM_SNAPSHOT_KEY is not set: snapshot persistence is off, " +
				"so this gateway cannot start while the control plane is unreachable")
		}
	}

	// Shared copy of the snapshot in Valkey, inside the data plane's failure
	// domain, so a gateway that starts during a control plane outage can
	// still serve (ADR-0008). Its own connection: never on the request path.
	var shared *snapstore.Store
	if cfg.SharedSnapshotEnabled() {
		vo := valkeyOptions(cfg)
		// The snapshot can be megabytes; allow more than the 1 s per command
		// that suits quota flushes.
		vo.IOTimeout = 15 * time.Second
		shared = &snapstore.Store{Client: valkey.New(vo), Key: snapstore.Key(cfg.ValkeyKeyPrefix, cfg.InstanceID)}
		m.SnapshotSharedEnabled.Store(1)
	} else if cfg.Mode == config.ModeControlPlane && cfg.ValkeyURL != "" && cfg.SnapshotKey == nil {
		log.Warn("STRATUM_SNAPSHOT_KEY is not set: the snapshot is not shared through Valkey, " +
			"so a gateway that starts while the control plane is unreachable cannot serve")
	}

	// 2. Configuration source.
	switch cfg.Mode {
	case config.ModeStatic:
		if err := loadStatic(cfg, holder, m, log); err != nil {
			log.Error("cannot load configuration file", "path", cfg.ConfigFile, "err", err)
			return 1
		}
		go reloadOnSIGHUP(ctx, cfg, holder, m, log)
	case config.ModeControlPlane:
		cp := &syncer.ControlPlane{
			URL: cfg.CPURL, Token: cfg.SyncToken, InstanceID: cfg.InstanceID,
			UserAgent: userAgent(), Interval: cfg.SyncInterval, FullEvery: cfg.FullResyncInterval,
			MaxDropRatio: cfg.SnapshotMaxDropRatio, GuardMinKeys: cfg.SnapshotGuardMinKeys,
			Holder: holder, Client: &http.Client{Timeout: 30 * time.Second},
			Log: log.With("component", "sync"), Metrics: m,
		}
		if cfg.PersistenceEnabled() || shared != nil {
			cp.Persist = persister(ctx, cfg, shared, m, log)
		}
		base := holder.State() // nil, or the snapshot restored from disk
		go cp.Run(ctx)
		if shared != nil {
			go bootstrapFromShared(ctx, cfg, holder, base, shared, m, log)
		}
	}

	// 3. Quotas: shared counters in Valkey when configured, local otherwise.
	//    Valkey is never on the request path (ADR-0004).
	var enforcer quota.Enforcer = quota.NewLocal()
	quotaDone := make(chan struct{})
	if cfg.ValkeyURL != "" {
		vo := valkeyOptions(cfg)
		sharedQuota := quota.NewShared(quota.SharedOptions{
			Client: valkey.New(vo), Prefix: cfg.ValkeyKeyPrefix,
			Interval: cfg.QuotaSyncInterval, StaleAfter: cfg.QuotaStaleAfter,
			FailClosed: cfg.QuotaFailClosed, Metrics: m, Log: log.With("component", "quota"),
		})
		enforcer = sharedQuota
		go func() { defer close(quotaDone); sharedQuota.Run(ctx, 3*time.Second) }()
		log.Info("quotas use the shared store", "addr", vo.Addr, "tls", vo.TLS != nil,
			"fail_mode", map[bool]string{true: "closed", false: "open"}[cfg.QuotaFailClosed])
	} else {
		close(quotaDone)
		log.Info("quotas use local counters (set STRATUM_VALKEY_URL to share them across replicas)")
	}

	// 4. Usage reported to the control plane, off the request path (ADR-0009).
	var pusher *usage.Pusher
	usageDone := make(chan struct{})
	if cfg.UsagePushEnabled() {
		pusher = &usage.Pusher{
			URL: cfg.CPURL, Token: cfg.SyncToken, InstanceID: cfg.InstanceID, UserAgent: userAgent(),
			Client: &http.Client{Timeout: 30 * time.Second}, Interval: cfg.UsageInterval,
			MaxBuffer: cfg.UsageBuffer, Metrics: m, Log: log.With("component", "usage"),
		}
		m.UsageEnabled.Store(1)
		go func() { defer close(usageDone); pusher.Run(ctx) }()
	} else {
		close(usageDone)
	}

	// 5. Servers.
	px := &proxy.Handler{
		Holder: holder, Quota: enforcer, Metrics: m, Log: log.With("component", "proxy"),
		Client:            &http.Client{Transport: proxy.NewTransport(cfg.UpstreamHeaderTimeout)},
		MaxRequestBytes:   cfg.MaxRequestBytes,
		StreamIdleTimeout: cfg.StreamIdleTimeout,
		PIIEnabled:        cfg.PIIEnabled,
		UserAgent:         userAgent(),
		RequestID:         server.RequestID,
	}
	if pusher != nil {
		px.Usage = pusher
	}
	// Provider failures (ADR-0010).
	px.Retry = proxy.RetryOptions{Max: cfg.UpstreamRetries, MaxWait: cfg.UpstreamRetryMaxWait}
	px.Budget = resilience.NewBudget(cfg.RetryBudgetRatio, 1, 100)
	if cfg.BreakerThreshold > 0 {
		px.Breakers = resilience.NewBreakers(resilience.BreakerOptions{Threshold: cfg.BreakerThreshold, Cooldown: cfg.BreakerCooldown})
		px.Breakers.OnTrip = func(id string) {
			m.BreakerTrips.Add(1)
			log.Warn("provider failing; pausing requests to it", "provider_config", id, "cooldown", cfg.BreakerCooldown)
		}
	}
	opts := server.Options{Proxy: px, Health: hc, Metrics: m, Log: log,
		MaxInflight: cfg.MaxInflight, AllowedOrigins: cfg.CORSAllowedOrigins}

	public := server.NewHTTPServer(cfg.ListenAddr, server.Public(opts), log)
	if err := listen(public, log, "public"); err != nil {
		log.Error("cannot listen", "addr", cfg.ListenAddr, "err", err)
		return 1
	}
	var admin *http.Server
	if cfg.AdminAddr != "" {
		admin = server.NewHTTPServer(cfg.AdminAddr, server.Admin(opts), log)
		if err := listen(admin, log, "admin"); err != nil {
			log.Error("cannot listen", "addr", cfg.AdminAddr, "err", err)
			return 1
		}
	}

	// 6. Graceful shutdown: fail readiness, give the load balancer time to
	//    notice, stop accepting, then wait for in-flight streams to finish.
	sigs := make(chan os.Signal, 2)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	sig := <-sigs
	hc.SetDraining()
	log.Info("shutdown requested; draining", "signal", sig.String(), "drain_delay", cfg.DrainDelay)

	select {
	case <-time.After(cfg.DrainDelay):
	case <-sigs:
		log.Warn("second signal received, exiting immediately")
		return 1
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	go func() {
		<-sigs
		log.Warn("second signal received, cutting remaining connections")
		cancel()
	}()

	code := 0
	if err := public.Shutdown(shutdownCtx); err != nil {
		log.Warn("shutdown deadline reached; closing remaining connections", "err", err)
		public.Close()
		code = 1
	}
	if admin != nil {
		adminCtx, c := context.WithTimeout(context.Background(), 2*time.Second)
		admin.Shutdown(adminCtx)
		c()
	}
	stopBackground()
	<-quotaDone // last flush of token usage, bounded
	<-usageDone
	if pusher != nil {
		// Every request has finished: send what they recorded.
		flushCtx, c := context.WithTimeout(context.Background(), 15*time.Second)
		pusher.Flush(flushCtx)
		c()
	}
	log.Info("stopped")
	return code
}

func listen(srv *http.Server, log *slog.Logger, name string) error {
	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		return err
	}
	log.Info("listening", "server", name, "addr", ln.Addr().String())
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server stopped unexpectedly", "server", name, "err", err)
			os.Exit(1)
		}
	}()
	return nil
}

func restoreSnapshot(cfg *config.Config, holder *snapshot.Holder, m *metrics.Metrics, log *slog.Logger) {
	st, err := snapshot.Load(cfg.SnapshotPath, cfg.SnapshotKey)
	switch {
	case errors.Is(err, snapshot.ErrNoSnapshot):
		log.Info("no snapshot on disk yet; waiting for the first sync", "path", cfg.SnapshotPath)
		return
	case err != nil:
		log.Error("cannot read snapshot from disk; waiting for the first sync", "err", err)
		return
	}
	var savedAt time.Time
	if fi, err := os.Stat(cfg.SnapshotPath); err == nil {
		savedAt = fi.ModTime()
	}
	holder.Store(st, snapshot.Build(st, savedAt))
	m.SnapshotVersion.Store(st.Version)
	m.SnapshotSynced.Store(savedAt.Unix())
	log.Info("restored snapshot from disk", "version", st.Version, "saved_at", savedAt)
}

func valkeyOptions(cfg *config.Config) valkey.Options {
	vo, _ := valkey.ParseURL(cfg.ValkeyURL) // validated by config
	if cfg.ValkeyPassword != "" {
		vo.Password = cfg.ValkeyPassword
	}
	if cfg.ValkeyRootCAs != nil && vo.TLS != nil {
		vo.TLS.RootCAs = cfg.ValkeyRootCAs
	}
	return vo
}

// persister writes each applied change to disk and, when enabled, to the
// shared copy in Valkey. The snapshot is encrypted once; both get the same
// bytes. A version lower than the one it replaces means the control plane's
// database went back in time, so the shared copy is overwritten even though
// its version is higher.
func persister(ctx context.Context, cfg *config.Config, shared *snapstore.Store, m *metrics.Metrics, log *slog.Logger) func(prev, next *snapshot.State, full bool) {
	return func(prev, next *snapshot.State, full bool) {
		sealed, err := snapshot.Seal(cfg.SnapshotKey, next)
		if err != nil {
			m.PersistFailure.Add(1)
			log.Error("cannot encrypt snapshot", "err", err)
			return
		}
		if cfg.PersistenceEnabled() {
			if err := snapshot.SaveSealed(cfg.SnapshotPath, sealed); err != nil {
				m.PersistFailure.Add(1)
				log.Error("cannot persist snapshot", "path", cfg.SnapshotPath, "err", err)
			}
		}
		if shared == nil {
			return
		}
		mode := snapstore.ModeDelta
		switch {
		case prev != nil && prev.Version > next.Version:
			mode = snapstore.ModeForce
		case full:
			mode = snapstore.ModeFull
		}
		wctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		stored, err := shared.Put(wctx, next.Version, sealed, time.Now(), mode)
		switch {
		case err != nil:
			m.SnapshotSharedWriteFailures.Add(1)
			log.Warn("cannot store snapshot in Valkey; retrying at the next change or full resync",
				"version", next.Version, "err", err)
		case stored:
			m.SnapshotSharedWrites.Add(1)
			log.Debug("snapshot stored in Valkey", "version", next.Version, "mode", string(mode))
		}
	}
}

// bootstrapFromShared serves the copy in Valkey when the control plane has
// not answered within STRATUM_SNAPSHOT_BOOTSTRAP_TIMEOUT and the copy is
// newer than what this gateway has (nothing, or its disk snapshot).
func bootstrapFromShared(ctx context.Context, cfg *config.Config, holder *snapshot.Holder, base *snapshot.State, shared *snapstore.Store, m *metrics.Metrics, log *slog.Logger) {
	out, st, err := snapstore.Bootstrap(ctx, holder, base, shared, cfg.SnapshotKey, cfg.SnapshotBootstrapTimeout, 200*time.Millisecond)
	switch out {
	case snapstore.Loaded:
		m.SnapshotSharedBootstraps.Add(1)
		// Metrics follow the holder; a sync that landed right after the
		// load has already set them.
		if snap := holder.Load(); holder.State() == st && snap != nil {
			m.SnapshotVersion.Store(st.Version)
			if !snap.SyncedAt.IsZero() {
				m.SnapshotSynced.Store(snap.SyncedAt.Unix())
			}
		}
		log.Warn("control plane did not answer in time; serving the snapshot shared through Valkey",
			"version", st.Version, "waited", cfg.SnapshotBootstrapTimeout.String())
	case snapstore.Missing:
		if holder.Load() == nil {
			log.Warn("control plane did not answer in time and Valkey has no snapshot for this instance; waiting for the control plane")
		}
	case snapstore.Failed:
		if ctx.Err() == nil {
			log.Error("cannot read the snapshot shared through Valkey; waiting for the control plane", "err", err)
		}
	}
}

func loadStatic(cfg *config.Config, holder *snapshot.Holder, m *metrics.Metrics, log *slog.Logger) error {
	st, err := syncer.LoadStatic(cfg.ConfigFile, os.Getenv)
	if err != nil {
		m.SyncFailure.Add(1)
		return err
	}
	now := time.Now()
	snap := snapshot.Build(st, now)
	holder.Store(st, snap)
	m.SyncSuccess.Add(1)
	m.SnapshotVersion.Store(st.Version)
	m.SnapshotSynced.Store(now.Unix())
	log.Info("configuration loaded", "path", cfg.ConfigFile, "version", st.Version,
		"active_keys", snap.ActiveKeys(), "providers", snap.ProviderSlugs())
	return nil
}

// reloadOnSIGHUP re-reads the configuration file. A broken file is logged
// and ignored: the gateway keeps serving the previous configuration.
func reloadOnSIGHUP(ctx context.Context, cfg *config.Config, holder *snapshot.Holder, m *metrics.Metrics, log *slog.Logger) {
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	defer signal.Stop(hup)
	for {
		select {
		case <-ctx.Done():
			return
		case <-hup:
			if err := loadStatic(cfg, holder, m, log); err != nil {
				log.Error("reload failed; keeping previous configuration", "err", err)
			}
		}
	}
}

func healthcheck() int {
	addr := os.Getenv("STRATUM_LISTEN_ADDR")
	if addr == "" {
		addr = ":20128"
	}
	client := &http.Client{Timeout: 3 * time.Second}
	res, err := client.Get("http://" + server.ListenHost(addr) + "/readyz")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "not ready:", res.Status)
		return 1
	}
	return 0
}

func hashKey(args []string) int {
	var key string
	if len(args) > 0 {
		key = args[0]
	} else {
		// Reading from stdin keeps the key out of shell history.
		s := bufio.NewScanner(os.Stdin)
		if s.Scan() {
			key = s.Text()
		}
	}
	key = strings.TrimSpace(key)
	if key == "" {
		fmt.Fprintln(os.Stderr, "usage: stratum-gateway hash-key <key>   (or pipe the key on stdin)")
		return 2
	}
	fmt.Println(auth.HashKey(key))
	return 0
}

func newLogger(level string) *slog.Logger {
	var l slog.Level
	l.UnmarshalText([]byte(level))
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: l}))
}

func userAgent() string { return "stratum-gateway/" + version }

func revision() string {
	if commit != "" {
		return commit
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			if s.Key == "vcs.revision" {
				return s.Value
			}
		}
	}
	return "unknown"
}
