// Package auth resolves developer API keys against the in-memory snapshot.
// There is no network or disk access here: a request is authenticated with
// one SHA-256 and one map lookup.
package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"

	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

var (
	ErrMissingKey = errors.New("missing API key")
	ErrUnknownKey = errors.New("invalid API key")
)

// HashKey returns the lowercase SHA-256 hex digest of a raw API key, the
// same value the control plane stores and syncs as key_hash.
func HashKey(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// ExtractKey reads the developer key from "Authorization: Bearer <key>" or,
// for Anthropic SDK clients, from "x-api-key: <key>".
func ExtractKey(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
			return strings.TrimSpace(h[7:])
		}
		return ""
	}
	return strings.TrimSpace(r.Header.Get("X-Api-Key"))
}

// Resolve authenticates a raw key. Revoked and unknown keys return the same
// error so callers cannot probe which keys once existed.
func Resolve(snap *snapshot.Snapshot, raw string) (snapshot.Key, error) {
	if raw == "" {
		return snapshot.Key{}, ErrMissingKey
	}
	k, ok := snap.KeyByHash(HashKey(raw))
	if !ok {
		return snapshot.Key{}, ErrUnknownKey
	}
	return k, nil
}
