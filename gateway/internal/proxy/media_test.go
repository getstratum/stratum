package proxy

import (
	"bytes"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
	"time"
)

// audioForm is a transcription as a client sends it.
func audioForm(t *testing.T, fields map[string]string, audio []byte) (string, []byte) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "nota.mp3")
	fw.Write(audio)
	for k, v := range fields {
		mw.WriteField(k, v)
	}
	mw.Close()
	return mw.FormDataContentType(), buf.Bytes()
}

func (e *env) postForm(path, key, ctype string, body []byte) *http.Response {
	e.t.Helper()
	req, _ := http.NewRequest(http.MethodPost, e.gw.URL+path, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", ctype)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { res.Body.Close() })
	return res
}

func TestATranscriptionGoesAsAFormWithTheProvidersModel(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute, func(h *Handler) { h.MaxAudioBytes = 4 << 20 })
	e.up.handler = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"text":"hola","language":"es","duration":83.5,"segments":[]}`)
	}
	audio := bytes.Repeat([]byte{0xff, 0xfb, 0x90, 0x00}, 512<<10) // 2 MiB: over MaxRequestBytes, under the audio limit
	ctype, body := audioForm(t, map[string]string{"model": "openai/whisper-1", "response_format": "verbose_json", "prompt": "mail juana@ejemplo.com"}, audio)
	res := e.postForm("/v1/audio/transcriptions", devKey, ctype, body)
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("status %d: %s", res.StatusCode, b)
	}
	e.up.mu.Lock()
	raw, hdr := e.up.raw, e.up.header
	e.up.mu.Unlock()
	mt, params, _ := mime.ParseMediaType(hdr.Get("Content-Type"))
	if mt != "multipart/form-data" {
		t.Fatalf("upstream content type %q", hdr.Get("Content-Type"))
	}
	got := map[string]string{}
	var file []byte
	mr := multipart.NewReader(bytes.NewReader(raw), params["boundary"])
	for {
		p, err := mr.NextPart()
		if err != nil {
			break
		}
		data, _ := io.ReadAll(p)
		if p.FileName() != "" {
			file = data
			continue
		}
		got[p.FormName()] = string(data)
	}
	if got["model"] != "whisper-1" || got["response_format"] != "verbose_json" {
		t.Errorf("fields upstream: %v", got)
	}
	if !bytes.Equal(file, audio) {
		t.Errorf("the audio changed: %d bytes, want %d", len(file), len(audio))
	}
	if strings.Contains(got["prompt"], "juana@") {
		t.Errorf("the prompt was not redacted: %q", got["prompt"])
	}
	rec := e.usage.wait(t, 1)[0]
	if rec.AudioSeconds != 83.5 || rec.Images != 0 || rec.Model != "whisper-1" {
		t.Errorf("usage %+v", rec)
	}
}

func TestMediaRefusals(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute, func(h *Handler) { h.MaxAudioBytes = 2 << 20 })
	ctype, body := audioForm(t, map[string]string{}, []byte("x"))
	if res := e.postForm("/v1/audio/transcriptions", devKey, ctype, body); res.StatusCode != 400 || errCode(t, res) != "model_required" {
		t.Errorf("no model: %d", res.StatusCode)
	}
	if res := e.postForm("/v1/audio/transcriptions", devKey, "multipart/form-data; boundary=x", []byte("--x--")); res.StatusCode != 400 || errCode(t, res) != "invalid_form" {
		t.Errorf("no file: %d", res.StatusCode)
	}
	ctype, body = audioForm(t, map[string]string{"model": "openai/whisper-1"}, bytes.Repeat([]byte{1}, 3<<20))
	if res := e.postForm("/v1/audio/transcriptions", devKey, ctype, body); res.StatusCode != 413 {
		t.Errorf("too large: %d", res.StatusCode)
	}
	// A form anywhere else is not JSON.
	ctype, body = audioForm(t, map[string]string{"model": "openai/gpt-4o"}, []byte("x"))
	if res := e.postForm("/v1/chat/completions", devKey, ctype, body); res.StatusCode != 400 || errCode(t, res) != "invalid_json" {
		t.Errorf("form to chat: %d", res.StatusCode)
	}
	// An image names its model: the policy's default is a chat model.
	if res := e.post("/v1/images/generations", devKey, `{"prompt":"un faro"}`); res.StatusCode != 400 || errCode(t, res) != "model_required" {
		t.Errorf("image without a model: %d", res.StatusCode)
	}
}

func TestImagesAreCountedOnlyOnTheirPath(t *testing.T) {
	e := newEnv(t, allowAll, time.Minute)
	e.up.handler = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"created":1,"data":[{"b64_json":"aGk="},{"b64_json":"aGk="}],"usage":{"input_tokens":12,"output_tokens":4160}}`)
	}
	if res := e.post("/v1/images/generations", devKey, `{"model":"openai/gpt-image-1","prompt":"un faro","n":2}`); res.StatusCode != 200 {
		t.Fatalf("image: %d", res.StatusCode)
	}
	if res := e.post("/v1/embeddings", devKey, `{"model":"openai/text-embedding-3-small","input":"hola"}`); res.StatusCode != 200 {
		t.Fatalf("embeddings: %d", res.StatusCode)
	}
	got := e.usage.wait(t, 2)
	img, emb := got[0], got[1]
	if img.Model != "text-embedding-3-small" && img.Images != 2 {
		img, emb = emb, img
	}
	if img.Images != 2 || img.TokensIn != 12 || img.TokensOut != 4160 {
		t.Errorf("image usage %+v", img)
	}
	if emb.Images != 0 {
		t.Errorf("embeddings counted as images: %+v", emb)
	}
}
