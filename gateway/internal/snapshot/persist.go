package snapshot

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// On-disk format: magic | 12-byte nonce | AES-256-GCM(JSON(State)).
// The file holds provider credentials, so it is always encrypted.
var magic = []byte("STRSNAP1")

// ErrNoSnapshot means there is no snapshot file yet (first boot).
var ErrNoSnapshot = errors.New("snapshot: no snapshot file")

// Seal encrypts st into the snapshot format. The same bytes go to disk and
// to the shared store (ADR-0008), so neither ever holds plaintext.
func Seal(key []byte, st *State) ([]byte, error) {
	plain, err := json.Marshal(st)
	if err != nil {
		return nil, err
	}
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(magic)+len(nonce)+len(plain)+aead.Overhead())
	out = append(out, magic...)
	out = append(out, nonce...)
	return aead.Seal(out, nonce, plain, magic), nil
}

// Open decrypts and decodes bytes produced by Seal. It fails on a wrong key
// or on any modification of the bytes (AES-GCM authenticates them).
func Open(key, raw []byte) (*State, error) {
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	if len(raw) < len(magic)+aead.NonceSize() || !bytes.Equal(raw[:len(magic)], magic) {
		return nil, errors.New("snapshot: not a snapshot")
	}
	nonce := raw[len(magic) : len(magic)+aead.NonceSize()]
	plain, err := aead.Open(nil, nonce, raw[len(magic)+aead.NonceSize():], magic)
	if err != nil {
		return nil, fmt.Errorf("snapshot: cannot decrypt (wrong STRATUM_SNAPSHOT_KEY?): %w", err)
	}
	st := NewState()
	if err := json.Unmarshal(plain, st); err != nil {
		return nil, fmt.Errorf("snapshot: corrupt state: %w", err)
	}
	return st, nil
}

// Save writes st to path atomically: temp file, fsync, rename, fsync dir.
// A crash at any point leaves either the old file or the new one, never a
// torn write.
func Save(path string, key []byte, st *State) error {
	sealed, err := Seal(key, st)
	if err != nil {
		return err
	}
	return SaveSealed(path, sealed)
}

// SaveSealed writes bytes produced by Seal to path, atomically.
func SaveSealed(path string, sealed []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".snapshot-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename

	if _, err := tmp.Write(sealed); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}

// Load reads and decrypts a snapshot written by Save.
func Load(path string, key []byte) (*State, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNoSnapshot
	}
	if err != nil {
		return nil, err
	}
	st, err := Open(key, raw)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return st, nil
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("snapshot: encryption key must be 32 bytes, got %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
