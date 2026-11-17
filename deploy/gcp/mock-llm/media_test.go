package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestImagesAreRealPictures(t *testing.T) {
	rr := httptest.NewRecorder()
	images(rr, httptest.NewRequest(http.MethodPost, "/v1/images/generations", strings.NewReader(`{"model":"m","prompt":"un faro","n":2}`)))
	var out struct {
		Data []struct {
			B64 string `json:"b64_json"`
		}
		Usage struct {
			Output int `json:"output_tokens"`
		}
	}
	if err := json.NewDecoder(rr.Body).Decode(&out); err != nil || len(out.Data) != 2 || out.Usage.Output != 544 {
		t.Fatalf("%v %+v", err, out)
	}
	raw, _ := base64.StdEncoding.DecodeString(out.Data[0].B64)
	if _, err := png.Decode(bytes.NewReader(raw)); err != nil {
		t.Fatal(err)
	}
}

func TestTranscriptionsSayHowLong(t *testing.T) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "nota.mp3")
	fw.Write(make([]byte, 48000))
	mw.WriteField("model", "whisper-1")
	mw.WriteField("response_format", "verbose_json")
	mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/v1/audio/transcriptions", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	transcriptions(rr, req)
	var out struct {
		Text     string
		Duration float64
	}
	if err := json.NewDecoder(rr.Body).Decode(&out); err != nil || out.Duration != 3 || !strings.Contains(out.Text, "nota.mp3") {
		t.Fatalf("%v %+v", err, out)
	}
}
