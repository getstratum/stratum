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

// Save writes st to path atomically: temp file, fsync, rename, fsync dir.
// A crash at any point leaves either the old file or the new one, never a
// torn write.
func Save(path string, key []byte, st *State) error {
	plain, err := json.Marshal(st)
	if err != nil {
		return err
	}
	aead, err := newAEAD(key)
	if err != nil {
		return err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return err
	}

	var buf bytes.Buffer
	buf.Grow(len(magic) + len(nonce) + len(plain) + aead.Overhead())
	buf.Write(magic)
	buf.Write(nonce)
	buf.Write(aead.Seal(nil, nonce, plain, magic))

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

	if _, err := tmp.Write(buf.Bytes()); err != nil {
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
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	if len(raw) < len(magic)+aead.NonceSize() || !bytes.Equal(raw[:len(magic)], magic) {
		return nil, fmt.Errorf("snapshot: %s is not a snapshot file", path)
	}
	nonce := raw[len(magic) : len(magic)+aead.NonceSize()]
	plain, err := aead.Open(nil, nonce, raw[len(magic)+aead.NonceSize():], magic)
	if err != nil {
		return nil, fmt.Errorf("snapshot: cannot decrypt %s (wrong STRATUM_SNAPSHOT_KEY?): %w", path, err)
	}
	st := NewState()
	if err := json.Unmarshal(plain, st); err != nil {
		return nil, fmt.Errorf("snapshot: corrupt state in %s: %w", path, err)
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
