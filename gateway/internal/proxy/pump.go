package proxy

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/getstratum/stratum/gateway/internal/provider"
)

// Usage is the token count reported by the provider.
type Usage struct {
	// Input is every input token, those of the prompt cache included, as
	// providers count them on their usage pages: OpenAI's prompt_tokens
	// already include the cached ones; Anthropic's input_tokens do not, and
	// its cache_creation_input_tokens and cache_read_input_tokens are added.
	Input  int64
	Output int64
	// The part of Input written to or read from the prompt cache, priced
	// apart (a write costs more than an input token, a read much less).
	CacheWrite int64
	CacheRead  int64
	// Anthropic's input_tokens: the part of the prompt not in its cache.
	anthropicIn int64
	// What images and transcriptions are priced by (ADR-0018).
	Images       int64
	AudioSeconds float64
}

var errIdle = errors.New("upstream stream idle timeout")

const (
	maxLine       = 1 << 20 // longest SSE line we try to parse for usage
	maxBufferBody = 8 << 20 // largest non-stream body we buffer for usage
)

// pump copies the upstream body to the client byte for byte as it arrives
// (no added latency, no re-framing) and, on the side, extracts token usage.
//
// A watchdog cancels the upstream request when no bytes arrive for
// idleTimeout, so a provider that hangs mid-stream releases the connection
// instead of holding it until the client gives up.
func pump(w http.ResponseWriter, body io.Reader, cancel func(), idleTimeout time.Duration,
	stream bool, kind provider.Kind) (Usage, error) {

	var idleFired atomic.Bool
	watchdog := time.AfterFunc(idleTimeout, func() {
		idleFired.Store(true)
		cancel()
	})
	defer watchdog.Stop()

	flusher, _ := w.(http.Flusher)
	var lines lineSplitter
	var whole bytes.Buffer
	var usage Usage

	buf := make([]byte, 32<<10)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			watchdog.Reset(idleTimeout)
			if _, werr := w.Write(buf[:n]); werr != nil {
				return usage, werr // client went away
			}
			if stream {
				if flusher != nil {
					flusher.Flush()
				}
				lines.feed(buf[:n], func(line []byte) { parseSSELine(line, kind, &usage) })
			} else if whole.Len()+n <= maxBufferBody {
				whole.Write(buf[:n])
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			if idleFired.Load() {
				return usage, errIdle
			}
			return usage, err
		}
	}

	if !stream && whole.Len() > 0 {
		parseBodyUsage(whole.Bytes(), kind, &usage)
	}
	return usage, nil
}

// lineSplitter turns a byte stream into lines without imposing a maximum
// line length on the passthrough; overly long lines are only skipped for
// parsing.
type lineSplitter struct {
	cur      []byte
	overflow bool
}

func (s *lineSplitter) feed(p []byte, fn func([]byte)) {
	for len(p) > 0 {
		i := bytes.IndexByte(p, '\n')
		chunk := p
		if i >= 0 {
			chunk = p[:i]
		}
		if !s.overflow {
			if len(s.cur)+len(chunk) > maxLine {
				s.overflow, s.cur = true, s.cur[:0]
			} else {
				s.cur = append(s.cur, chunk...)
			}
		}
		if i < 0 {
			return
		}
		if !s.overflow {
			fn(bytes.TrimRight(s.cur, "\r"))
		}
		s.cur, s.overflow = s.cur[:0], false
		p = p[i+1:]
	}
}

func parseSSELine(line []byte, kind provider.Kind, u *Usage) {
	payload, ok := bytes.CutPrefix(line, []byte("data:"))
	if !ok {
		return
	}
	payload = bytes.TrimSpace(payload)
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return
	}
	var evt usageEvent
	if json.Unmarshal(payload, &evt) != nil {
		return
	}
	evt.apply(kind, u)
}

func parseBodyUsage(body []byte, kind provider.Kind, u *Usage) {
	var evt usageEvent
	if json.Unmarshal(body, &evt) != nil {
		return
	}
	evt.apply(kind, u)
}

// usageEvent covers the usage fields of both wire protocols:
//
//	OpenAI-compatible: {"usage": {"prompt_tokens", "completion_tokens"}}
//	                   prompt_tokens_details.cached_tokens: the part read from the cache
//	Anthropic:         {"type": "message_start", "message": {"usage": {"input_tokens",
//	                   "cache_creation_input_tokens", "cache_read_input_tokens"}}}
//	                   {"type": "message_delta", "usage": {"output_tokens"}} (and,
//	                   from 2025, the input fields again, cumulative)
//	                   non-stream: {"usage": {"input_tokens", "output_tokens", "cache_…"}}
type usageEvent struct {
	Type  string      `json:"type"`
	Usage *usageField `json:"usage"`
	// An image generation: the images made.
	Data []json.RawMessage `json:"data"`
	// A transcription in verbose_json: the audio's length.
	Duration float64 `json:"duration"`
	Message  *struct {
		Usage *usageField `json:"usage"`
	} `json:"message"`
}

type usageField struct {
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
	InputTokens      int64 `json:"input_tokens"`
	OutputTokens     int64 `json:"output_tokens"`
	// Anthropic's prompt cache.
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	// OpenAI's (and OpenAI-compatible) prompt cache: part of prompt_tokens.
	PromptTokensDetails *struct {
		CachedTokens int64 `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	// A transcription billed by duration: {"type":"duration","seconds":N}.
	Kind    string  `json:"type"`
	Seconds float64 `json:"seconds"`
}

func (e *usageEvent) apply(kind provider.Kind, u *Usage) {
	if kind != provider.KindAnthropic {
		if e.Usage != nil {
			u.Input, u.Output = e.Usage.PromptTokens, e.Usage.CompletionTokens
			if d := e.Usage.PromptTokensDetails; d != nil && d.CachedTokens > 0 && d.CachedTokens <= u.Input {
				u.CacheRead = d.CachedTokens
			}
			// Images and transcriptions name them as Anthropic does
			// (gpt-image-1, gpt-4o-transcribe).
			if u.Input == 0 && u.Output == 0 {
				u.Input, u.Output = e.Usage.InputTokens, e.Usage.OutputTokens
			}
			if e.Usage.Kind == "duration" && e.Usage.Seconds > 0 {
				u.AudioSeconds = e.Usage.Seconds
			}
		}
		if len(e.Data) > 0 {
			u.Images = int64(len(e.Data))
		}
		if e.Duration > 0 && u.AudioSeconds == 0 {
			u.AudioSeconds = e.Duration
		}
		return
	}
	for _, f := range []*usageField{e.messageUsage(), e.Usage} {
		if f == nil {
			continue
		}
		if f.InputTokens > 0 {
			u.anthropicIn = f.InputTokens
		}
		if f.CacheCreationInputTokens > 0 {
			u.CacheWrite = f.CacheCreationInputTokens
		}
		if f.CacheReadInputTokens > 0 {
			u.CacheRead = f.CacheReadInputTokens
		}
		if f.OutputTokens > 0 {
			u.Output = f.OutputTokens
		}
	}
	u.Input = u.anthropicIn + u.CacheWrite + u.CacheRead
}

func (e *usageEvent) messageUsage() *usageField {
	if e.Message == nil {
		return nil
	}
	return e.Message.Usage
}
