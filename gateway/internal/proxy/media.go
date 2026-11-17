package proxy

// Images and transcriptions (ADR-0018). An image is asked for with JSON,
// like a chat; a transcription sends the audio as multipart/form-data, the
// only body the gateway takes that is not JSON. The form's text fields
// stand in for the JSON body (model, response_format, language, prompt):
// the model is routed and checked by the policy as any other, and the form
// is written again with the provider's model name.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/textproto"
	"strings"
)

// isAudioPath: an OpenAI-compatible transcription or translation.
func isAudioPath(p string) bool {
	p = strings.TrimSuffix(p, "/")
	return strings.HasSuffix(p, "audio/transcriptions") || strings.HasSuffix(p, "audio/translations")
}

// isImagePath: an OpenAI-compatible image generation (or edit, variation).
func isImagePath(p string) bool {
	p = strings.TrimSuffix(p, "/")
	return strings.HasSuffix(p, "images/generations") || strings.HasSuffix(p, "images/edits") || strings.HasSuffix(p, "images/variations")
}

// maxFormFields bounds the text fields a form may have; maxFieldBytes each.
const (
	maxFormFields = 32
	maxFieldBytes = 64 << 10
)

type formPart struct {
	name, filename string
	header         textproto.MIMEHeader
	data           []byte
}

// form is a multipart body as it came, in order.
type form struct {
	parts []formPart
}

var errNotForm = errors.New("not a multipart form")

// parseForm reads a multipart/form-data body. It returns the text fields as
// a map (what the JSON path reads) and the form.
func parseForm(contentType string, raw []byte) (map[string]any, *form, error) {
	mt, params, err := mime.ParseMediaType(contentType)
	if err != nil || mt != "multipart/form-data" || params["boundary"] == "" {
		return nil, nil, errNotForm
	}
	mr := multipart.NewReader(bytes.NewReader(raw), params["boundary"])
	f := &form{}
	fields := map[string]any{}
	for {
		p, err := mr.NextRawPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, err
		}
		data, err := io.ReadAll(p)
		if err != nil {
			return nil, nil, err
		}
		part := formPart{name: p.FormName(), filename: p.FileName(), header: p.Header, data: data}
		if part.name == "" {
			return nil, nil, errors.New("a form part without a name")
		}
		if part.filename == "" {
			if len(fields) >= maxFormFields || len(data) > maxFieldBytes {
				return nil, nil, errors.New("too many or too long form fields")
			}
			fields[part.name] = string(data)
		}
		f.parts = append(f.parts, part)
	}
	if !f.hasFile() {
		return nil, nil, errors.New("the form has no file")
	}
	return fields, f, nil
}

func (f *form) hasFile() bool {
	for _, p := range f.parts {
		if p.filename != "" {
			return true
		}
	}
	return false
}

// fileHash is the SHA-256 of the form's files, in order: the content the
// decision services see.
func (f *form) fileHash() string {
	h := sha256.New()
	for _, p := range f.parts {
		if p.filename != "" {
			h.Write(p.data)
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

// encode writes the form again with fields replaced (the model, a redacted
// prompt) and returns the body and its Content-Type.
func (f *form) encode(fields map[string]string) ([]byte, string, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	done := map[string]bool{}
	for _, p := range f.parts {
		data := p.data
		if v, ok := fields[p.name]; ok && p.filename == "" {
			data = []byte(v)
			done[p.name] = true
		}
		h := textproto.MIMEHeader{}
		for k, v := range p.header {
			h[k] = v
		}
		w, err := mw.CreatePart(h)
		if err != nil {
			return nil, "", err
		}
		if _, err := w.Write(data); err != nil {
			return nil, "", err
		}
	}
	// A field the form did not have (an agent's fixed model).
	for name, v := range fields {
		if !done[name] {
			if err := mw.WriteField(name, v); err != nil {
				return nil, "", err
			}
		}
	}
	if err := mw.Close(); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), mw.FormDataContentType(), nil
}
