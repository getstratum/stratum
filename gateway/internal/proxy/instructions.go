package proxy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/getstratum/stratum/gateway/internal/policy"
	"github.com/getstratum/stratum/gateway/internal/provider"
)

// The team's instructions for people (a policy's people_instructions) go
// first in the system instruction of every request an application makes
// for a person (X-Stratum-User): for example "when context is missing, ask
// before answering". Never in an agent's or a key's own requests: those
// expect the model as it is, and an instruction they did not write can
// break the format or the tools they rely on.
//
// They are not hidden: GET /v1/stratum/instructions returns them, so the
// application can show them, and a request they went into says so with
// X-Stratum-Instructions (their id).

// addInstructions puts text before the request's own system instruction,
// in the request's format. It reports whether it did: legacy completions
// and unknown paths have no system instruction and are left as they are.
func addInstructions(body map[string]any, upstreamPath string, kind provider.Kind, text string) bool {
	p := strings.TrimSuffix(upstreamPath, "/")
	switch {
	case kind == provider.KindAnthropic && strings.HasSuffix(p, "messages"):
		// Messages: "system" is a string or a list of content blocks.
		switch sys := body["system"].(type) {
		case nil:
			body["system"] = text
		case string:
			if strings.TrimSpace(sys) == "" {
				body["system"] = text
			} else {
				body["system"] = text + "\n\n" + sys
			}
		case []any:
			body["system"] = append([]any{map[string]any{"type": "text", "text": text}}, sys...)
		default:
			return false
		}
		return true
	case strings.HasSuffix(p, "/responses") || p == "responses":
		switch ins := body["instructions"].(type) {
		case nil:
			body["instructions"] = text
		case string:
			if strings.TrimSpace(ins) == "" {
				body["instructions"] = text
			} else {
				body["instructions"] = text + "\n\n" + ins
			}
		default:
			return false
		}
		return true
	case strings.HasSuffix(p, "chat/completions"):
		msgs, ok := body["messages"].([]any)
		if !ok {
			return false // the provider refuses it anyway
		}
		body["messages"] = append([]any{map[string]any{"role": "system", "content": text}}, msgs...)
		return true
	}
	return false
}

// instructionsID names a version of the instructions, for the header and
// for an application that caches what it shows.
func instructionsID(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:6])
}

// Instructions answers GET /v1/stratum/instructions: the instructions the
// gateway adds to this caller's requests. Only a delegating key acting for
// a person gets any; any other caller gets null, since none are added to
// its requests.
func (h *Handler) Instructions(w http.ResponseWriter, r *http.Request) {
	rec := &record{start: time.Now()}
	defer h.finishModels(rec)

	snap := h.Holder.Load()
	if snap == nil {
		h.fail(w, rec, &policy.Violation{Status: http.StatusServiceUnavailable, Code: "not_ready", Message: "gateway has no configuration yet"})
		return
	}
	_, teamID, userID, v := h.caller(r, snap)
	if v != nil {
		h.fail(w, rec, v)
		return
	}
	pol, found := snap.PolicyForTeam(teamID)
	if v := policyUsable(pol, found); v != nil {
		h.fail(w, rec, v)
		return
	}
	out := map[string]any{"instructions": nil, "id": nil}
	if userID != "" && pol.PeopleInstructions != "" {
		out["instructions"] = pol.PeopleInstructions
		out["id"] = instructionsID(pol.PeopleInstructions)
	}
	rec.status, rec.reason = http.StatusOK, "ok"
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(out)
}
