// Package server wires handlers and the cross-cutting middleware: request
// IDs, panic recovery, CORS and the concurrency limiter that sheds load
// before the process falls over.
package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/getstratum/stratum/gateway/internal/health"
	"github.com/getstratum/stratum/gateway/internal/metrics"
)

type Options struct {
	Proxy          http.Handler
	Models         http.Handler // GET /v1/models; optional
	Instructions   http.Handler // GET /v1/stratum/instructions; optional
	Health         *health.Health
	Metrics        *metrics.Metrics
	Log            *slog.Logger
	MaxInflight    int
	AllowedOrigins []string
}

// Public builds the handler for client traffic.
func Public(o Options) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /livez", o.Health.Live)
	mux.HandleFunc("GET /readyz", o.Health.Ready)
	limited := limit(o.Proxy, o.MaxInflight, o.Metrics)
	if o.Models != nil {
		mux.Handle("GET /v1/models", limit(o.Models, o.MaxInflight, o.Metrics))
	}
	if o.Instructions != nil {
		mux.Handle("GET /v1/stratum/instructions", limit(o.Instructions, o.MaxInflight, o.Metrics))
	}
	mux.Handle("/v1/", limited)
	mux.Handle("/proxy/", limited)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "unknown path")
	})
	return recoverer(o.Log, requestID(cors(o.AllowedOrigins, mux)))
}

// Admin builds the handler for operators: metrics and probes. Keep it off
// the public network.
func Admin(o Options) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /livez", o.Health.Live)
	mux.HandleFunc("GET /readyz", o.Health.Ready)
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		o.Metrics.WriteTo(w, time.Now())
	})
	return recoverer(o.Log, mux)
}

// NewHTTPServer applies timeouts that protect the gateway without cutting
// long streams: headers and bodies must arrive promptly, but there is no
// write timeout because a completion may stream for minutes.
func NewHTTPServer(addr string, h http.Handler, log *slog.Logger) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		// Longer than the keep-alive of cloud load balancers (600 s on
		// Google's, 350 s on AWS NLB): if the backend closed idle
		// connections first, a request racing the close would get a 502.
		IdleTimeout:    620 * time.Second,
		MaxHeaderBytes: 64 << 10,
		ErrorLog:       slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}
}

// limit rejects requests beyond max concurrent ones with 503 + Retry-After.
// Shedding early keeps latency bounded for the requests we do accept.
func limit(next http.Handler, max int, m *metrics.Metrics) http.Handler {
	sem := make(chan struct{}, max)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case sem <- struct{}{}:
		default:
			m.Overloaded.Add(1)
			m.Request(http.StatusServiceUnavailable, "", "overloaded")
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusServiceUnavailable, "overloaded", "gateway is at capacity, retry shortly")
			return
		}
		m.Inflight.Add(1)
		defer func() {
			m.Inflight.Add(-1)
			<-sem
		}()
		next.ServeHTTP(w, r)
	})
}

type ctxKey struct{}

var safeID = regexp.MustCompile(`^[A-Za-z0-9._\-]{1,128}$`)

// requestID propagates a caller-supplied X-Request-Id when it is sane and
// generates one otherwise.
func requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if !safeID.MatchString(id) {
			var b [8]byte
			rand.Read(b[:])
			id = hex.EncodeToString(b[:])
		}
		w.Header().Set("X-Stratum-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, id)))
	})
}

// RequestID returns the request ID stored by the middleware.
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(ctxKey{}).(string)
	return id
}

func cors(allowed []string, next http.Handler) http.Handler {
	if len(allowed) == 0 {
		return next
	}
	any := slices.Contains(allowed, "*")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && (any || slices.Contains(allowed, origin)) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Api-Key, Anthropic-Version, Anthropic-Beta, X-Request-Id, X-Stratum-Labels")
			h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			h.Set("Access-Control-Expose-Headers", "X-Stratum-Request-Id")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func recoverer(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				log.Error("panic in handler", "panic", v, "path", r.URL.Path)
				writeError(w, http.StatusInternalServerError, "internal", "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"message": msg, "type": "stratum_error", "code": code},
	})
}

// ListenHost turns ":20128" into "127.0.0.1:20128" for local probes.
func ListenHost(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return "127.0.0.1" + addr
	}
	return addr
}
