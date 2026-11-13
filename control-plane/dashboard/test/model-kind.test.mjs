// What kind of model each one is (lib/model-kind.js): by ID, by what a
// provider's list says, and in which order the sources win.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { kindOf, kindHint, effectiveKind, KINDS, KIND_LABELS } = await import('../lib/model-kind.js')
const { testConnection } = await import('../lib/providers.js')

test('kindOf: the IDs providers list next to their chat models', () => {
  const cases = {
    chat: ['gpt-5.5', 'gpt-4o-mini', 'o3', 'claude-opus-5-5', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b',
      'gemini-3.5-flash', 'gpt-4o-search-preview', 'llama-3.2-90b-vision-preview', 'mistral-large-latest', 'deepseek-chat'],
    embedding: ['text-embedding-3-small', 'gemini-embedding-001', 'mistral-embed', 'nomic-embed-text-v1.5',
      'intfloat/multilingual-e5-large', 'BAAI/bge-large-en-v1.5'],
    image: ['dall-e-3', 'gpt-image-1', 'imagen-4.0-generate-001', 'gemini-2.5-flash-image',
      'gemini-2.0-flash-exp-image-generation', 'black-forest-labs/FLUX.1-schnell', 'grok-2-image-1212'],
    transcription: ['whisper-1', 'whisper-large-v3-turbo', 'distil-whisper-large-v3-en', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'],
    speech: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'playai-tts', 'playai-tts-arabic', 'gemini-2.5-flash-preview-tts',
      'canopylabs/orpheus-v1-english'],
    moderation: ['omni-moderation-latest', 'text-moderation-stable', 'meta-llama/llama-guard-4-12b',
      'meta-llama/llama-prompt-guard-2-86m', 'mistral-moderation-latest'],
    other: ['gpt-4o-realtime-preview', 'gpt-realtime', 'veo-3.0-generate-001', 'sora-2', 'computer-use-preview',
      'davinci-002', 'babbage-002', 'aqa', 'gemini-2.5-flash-native-audio-preview-09-2025', 'rerank-v3.5'],
  }
  for (const [kind, ids] of Object.entries(cases)) {
    for (const id of ids) assert.equal(kindOf(id), kind, id)
  }
  assert.equal(kindOf(undefined), 'chat')
  assert.deepEqual(Object.keys(KIND_LABELS), KINDS, 'a label for every kind')
})

test('kindHint: what a provider\'s list says, when it says something', () => {
  assert.equal(kindHint({ id: 'x', type: 'embedding' }), 'embedding', 'Together')
  assert.equal(kindHint({ id: 'x', type: 'language' }), 'chat')
  assert.equal(kindHint({ id: 'x', type: 'audio' }), 'speech')
  assert.equal(kindHint({ id: 'x', type: 'something-new' }), null)
  assert.equal(kindHint({ id: 'mistral-large', capabilities: { completion_chat: true } }), 'chat', 'Mistral')
  assert.equal(kindHint({ id: 'mistral-embed', capabilities: { completion_chat: false } }), 'embedding')
  assert.equal(kindHint({ id: 'mistral-moderation-latest', capabilities: { completion_chat: false, classification: true } }), 'moderation')
  assert.equal(kindHint({ id: 'voxtral-mini-transcribe', capabilities: { completion_chat: false } }), 'transcription')
  assert.equal(kindHint({ id: 'x', architecture: { output_modalities: ['image', 'text'] } }), 'image', 'OpenRouter')
  assert.equal(kindHint({ id: 'x', architecture: { output_modalities: ['text'] } }), null, 'text: its ID says more')
  assert.equal(kindHint({ id: 'gpt-4o', object: 'model' }), null, 'OpenAI says nothing')
  assert.equal(kindHint(null), null)
})

test('effectiveKind: the organization, then the catalog, then the provider, then the ID', () => {
  assert.equal(effectiveKind({ own: 'other', catalog: 'chat', listed: 'image', id: 'whisper-1' }), 'other')
  assert.equal(effectiveKind({ catalog: 'chat', listed: 'image', id: 'whisper-1' }), 'chat')
  assert.equal(effectiveKind({ listed: 'image', id: 'whisper-1' }), 'image')
  assert.equal(effectiveKind({ own: null, catalog: null, listed: 'nope', id: 'whisper-1' }), 'transcription')
})

test('testConnection: the kinds a list says, and Together\'s bare array', async () => {
  const fake = body => async () => new Response(JSON.stringify(body), { status: 200 })
  const together = await testConnection('together', 'k', { fetchImpl: fake([
    { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', type: 'chat' },
    { id: 'BAAI/bge-large-en-v1.5', type: 'embedding' },
    { id: 'BAAI/bge-large-en-v1.5', type: 'embedding' }, // listed twice: once
  ]) })
  assert.deepEqual(together.ids, ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'BAAI/bge-large-en-v1.5'])
  assert.deepEqual(together.kinds, { 'meta-llama/Llama-3.3-70B-Instruct-Turbo': 'chat', 'BAAI/bge-large-en-v1.5': 'embedding' })
  const openai = await testConnection('openai', 'k', { fetchImpl: fake({ data: [{ id: 'gpt-4o' }, { id: 'whisper-1' }] }) })
  assert.deepEqual([openai.ids, openai.kinds], [['gpt-4o', 'whisper-1'], {}], 'nothing said: its ID decides later')
})
