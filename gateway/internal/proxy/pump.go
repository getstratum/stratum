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
	Input  int64
	Output int64
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
//	Anthropic:         {"type": "message_start", "message": {"usage": {"input_tokens"}}}
//	                   {"type": "message_delta", "usage": {"output_tokens"}}
//	                   non-stream: {"usage": {"input_tokens", "output_tokens"}}
type usageEvent struct {
	Type    string      `json:"type"`
	Usage   *usageField `json:"usage"`
	Message *struct {
		Usage *usageField `json:"usage"`
	} `json:"message"`
}

type usageField struct {
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
	InputTokens      int64 `json:"input_tokens"`
	OutputTokens     int64 `json:"output_tokens"`
}

func (e *usageEvent) apply(kind provider.Kind, u *Usage) {
	if kind != provider.KindAnthropic {
		if e.Usage != nil {
			u.Input, u.Output = e.Usage.PromptTokens, e.Usage.CompletionTokens
		}
		return
	}
	if e.Message != nil && e.Message.Usage != nil {
		u.Input = e.Message.Usage.InputTokens
	}
	if e.Usage != nil {
		if e.Usage.InputTokens > 0 {
			u.Input = e.Usage.InputTokens
		}
		if e.Usage.OutputTokens > 0 {
			u.Output = e.Usage.OutputTokens
		}
	}
}
