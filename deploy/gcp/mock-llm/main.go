// Command mock-llm is an OpenAI-compatible chat completions endpoint for
// load and failure testing. It returns fixed content with realistic timing
// and token usage, so tests exercise the gateway end to end without paying
// a real provider.
//
//	POST /v1/chat/completions   non-streamed or streamed (SSE)
//	GET  /healthz
//
// By default every response reports 60 prompt + 40 completion tokens (100
// total), which makes quota tests predictable. With MOCK_USAGE=request the
// usage follows the request instead, for usage and cost demos: prompt
// tokens about one per 4 characters of the messages, completion tokens the
// request's max_tokens (or max_completion_tokens), 40 without one.
//
// Environment:
//
//	MOCK_LATENCY_MS         time to first byte (default 300)
//	MOCK_STREAM_CHUNKS      chunks per streamed response (default 20)
//	MOCK_CHUNK_INTERVAL_MS  pause between chunks (default 100)
//	MOCK_USAGE              fixed (default) or request
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

const (
	promptTokens     = 60
	completionTokens = 40
)

type config struct {
	latency       time.Duration
	chunks        int
	chunkInterval time.Duration
	usageFromReq  bool
}

func main() {
	cfg := config{
		latency:       envMillis("MOCK_LATENCY_MS", 300),
		chunks:        envInt("MOCK_STREAM_CHUNKS", 20),
		chunkInterval: envMillis("MOCK_CHUNK_INTERVAL_MS", 100),
		usageFromReq:  os.Getenv("MOCK_USAGE") == "request",
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("POST /v1/chat/completions", cfg.chat)

	srv := &http.Server{Addr: ":8080", Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server stopped", "err", err)
			os.Exit(1)
		}
	}()
	slog.Info("mock-llm listening", "addr", srv.Addr, "latency", cfg.latency, "chunks", cfg.chunks)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
}

type request struct {
	Model               string            `json:"model"`
	Stream              bool              `json:"stream"`
	Messages            []json.RawMessage `json:"messages"`
	MaxTokens           int               `json:"max_tokens"`
	MaxCompletionTokens int               `json:"max_completion_tokens"`
}

// tokens returns the prompt and completion tokens a response reports.
func (c config) tokens(req request) (prompt, completion int) {
	if !c.usageFromReq {
		return promptTokens, completionTokens
	}
	chars := 0
	for _, m := range req.Messages {
		chars += len(m)
	}
	prompt = chars/4 + 1
	completion = req.MaxCompletionTokens
	if completion <= 0 {
		completion = req.MaxTokens
	}
	if completion <= 0 {
		completion = completionTokens
	}
	return prompt, min(completion, 100000)
}

func (c config) chat(w http.ResponseWriter, r *http.Request) {
	var req request
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 10<<20)).Decode(&req); err != nil {
		http.Error(w, `{"error":{"message":"invalid JSON"}}`, http.StatusBadRequest)
		return
	}
	if req.Model == "" {
		req.Model = "mock-1"
	}
	id := "chatcmpl-mock-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	created := time.Now().Unix()

	if !sleep(r.Context(), c.latency) {
		return
	}
	pt, ct := c.tokens(req)
	usage := map[string]int{"prompt_tokens": pt, "completion_tokens": ct, "total_tokens": pt + ct}

	if !req.Stream {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"id": id, "object": "chat.completion", "created": created, "model": req.Model,
			"choices": []any{map[string]any{
				"index": 0, "finish_reason": "stop",
				"message": map[string]string{"role": "assistant", "content": "This is a mock completion."},
			}},
			"usage": usage,
		})
		return
	}

	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	send := func(v any) {
		b, _ := json.Marshal(v)
		fmt.Fprintf(w, "data: %s\n\n", b)
		fl.Flush()
	}
	chunk := func(delta map[string]string, finish any) map[string]any {
		return map[string]any{
			"id": id, "object": "chat.completion.chunk", "created": created, "model": req.Model,
			"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}},
		}
	}
	send(chunk(map[string]string{"role": "assistant"}, nil))
	for i := 0; i < c.chunks; i++ {
		if i > 0 && !sleep(r.Context(), c.chunkInterval) {
			return
		}
		send(chunk(map[string]string{"content": fmt.Sprintf("token%d ", i)}, nil))
	}
	send(chunk(map[string]string{}, "stop"))
	// Usage in a final chunk with no choices, as OpenAI does with
	// stream_options.include_usage.
	send(map[string]any{"id": id, "object": "chat.completion.chunk", "created": created,
		"model": req.Model, "choices": []any{}, "usage": usage})
	fmt.Fprint(w, "data: [DONE]\n\n")
	fl.Flush()
}

func sleep(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return true
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}

func envInt(k string, def int) int {
	if n, err := strconv.Atoi(os.Getenv(k)); err == nil && n >= 0 {
		return n
	}
	return def
}

func envMillis(k string, def int) time.Duration {
	return time.Duration(envInt(k, def)) * time.Millisecond
}
