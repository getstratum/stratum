package main

// Images and transcriptions, as OpenAI-compatible providers answer them
// (the gateway's ADR-0018): enough for the demo and the tests to see a
// picture and a text come back, priced as a real provider would report.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"strings"
)

// picture draws a 256×256 gradient whose colours come from the prompt, so
// two prompts give two pictures.
func picture(prompt string, n int) []byte {
	h := fnv.New32a()
	fmt.Fprintf(h, "%s#%d", prompt, n)
	s := h.Sum32()
	a := color.RGBA{uint8(s), uint8(s >> 8), uint8(s >> 16), 255}
	b := color.RGBA{255 - a.R, 255 - a.G, 255 - a.B, 255}
	img := image.NewRGBA(image.Rect(0, 0, 256, 256))
	for y := 0; y < 256; y++ {
		for x := 0; x < 256; x++ {
			t := (x + y) / 2
			img.Set(x, y, color.RGBA{
				uint8((int(a.R)*(255-t) + int(b.R)*t) / 255),
				uint8((int(a.G)*(255-t) + int(b.G)*t) / 255),
				uint8((int(a.B)*(255-t) + int(b.B)*t) / 255), 255})
		}
	}
	var buf bytes.Buffer
	png.Encode(&buf, img)
	return buf.Bytes()
}

func images(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Model  string `json:"model"`
		Prompt string `json:"prompt"`
		N      int    `json:"n"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil || strings.TrimSpace(req.Prompt) == "" {
		http.Error(w, `{"error":{"message":"prompt is required","type":"invalid_request_error"}}`, http.StatusBadRequest)
		return
	}
	if req.N < 1 {
		req.N = 1
	}
	if req.N > 4 {
		req.N = 4
	}
	data := make([]map[string]any, req.N)
	for i := range data {
		data[i] = map[string]any{"b64_json": base64.StdEncoding.EncodeToString(picture(req.Prompt, i)), "revised_prompt": req.Prompt}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"created": 1, "data": data,
		// As gpt-image models report it: the prompt's tokens, and the image's.
		"usage": map[string]any{"input_tokens": len(strings.Fields(req.Prompt)) + 5, "output_tokens": 272 * req.N},
	})
}

// transcriptions answers with a text and, in verbose_json, the length of
// the audio as if it were 16 kB per second.
func transcriptions(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		http.Error(w, `{"error":{"message":"a multipart form is required","type":"invalid_request_error"}}`, http.StatusBadRequest)
		return
	}
	f, hdr, err := r.FormFile("file")
	if err != nil {
		http.Error(w, `{"error":{"message":"file is required","type":"invalid_request_error"}}`, http.StatusBadRequest)
		return
	}
	n, _ := io.Copy(io.Discard, f)
	f.Close()
	seconds := float64(n) / 16000
	if seconds < 1 {
		seconds = 1
	}
	text := fmt.Sprintf("Transcripción de prueba de %s: %d bytes de audio, unos %.0f segundos.", hdr.Filename, n, seconds)
	w.Header().Set("Content-Type", "application/json")
	switch r.FormValue("response_format") {
	case "verbose_json":
		json.NewEncoder(w).Encode(map[string]any{"task": "transcribe", "language": "spanish", "duration": seconds, "text": text, "segments": []any{}})
	case "text":
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, text)
	default:
		json.NewEncoder(w).Encode(map[string]any{"text": text})
	}
}
