# ADR-0018: Images and transcriptions through the gateway

- **Status:** Accepted
- **Date:** 2026-11-17

## Context

Since 0.6 models have a kind (chat, embedding, image, transcription…), but
the gateway only took JSON and priced requests by tokens. An image is asked
for with JSON and priced per image (or by tokens, as `gpt-image-*`); a
transcription sends the audio as `multipart/form-data` and is priced per
minute of audio. Stratum Enterprise's portal wants both, with the same
policy, records and costs as a chat.

## Decision

- **Images** (`/v1/images/generations`, `edits`, `variations`) go as any
  JSON request: routed, checked by the policy, PII and DLP on the prompt,
  decision services (operation `image_generation`). The gateway counts the
  images the answer brings (`data`) and the tokens it reports
  (`input_tokens`, `output_tokens`).
- **Transcriptions** (`/v1/audio/transcriptions`, `translations`) are the
  one body that is not JSON. The form's text fields stand in for it: its
  `model` is routed and checked as any other, and the form is written again
  with the provider's model name. PII and DLP apply to its `prompt` field;
  the audio is not scanned. The decision services get the SHA-256 of the
  audio (operation `transcription`). A transcription may be larger than a
  chat: `STRATUM_MAX_AUDIO_BYTES` (25 MiB by default, as OpenAI's limit).
  The gateway takes the audio's length from the answer: `duration` in
  `verbose_json`, or `usage` of type `duration`. A client that wants the
  cost asks for `verbose_json`.
- Neither takes the policy's default model: it is a chat model. An image or
  a transcription names its model (400 `model_required`).
- **Usage records** carry `images` and `audio_seconds` (api/usage/v1). The
  control plane prices them per image and per minute of audio, beside the
  tokens: the catalog's `per_image` and `per_audio_minute`, or the
  organization's own price in Modelos (migration 042). A request that used
  something with no price of it costs NULL ("sin precio"), as with tokens.

## Consequences

- The portal can generate images and transcribe audio with every control of
  the chat. Other clients (an agent, a script) get the same.
- Audio stays outside PII and DLP. A transcription's text comes back to the
  client; what the client does with it next goes through the gateway again.
- The mock LLM answers both, for the demo and the tests.
