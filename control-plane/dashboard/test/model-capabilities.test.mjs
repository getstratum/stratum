// What a chat model can do besides text (lib/model-capabilities.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capabilitiesOf, capabilityHints, effectiveCapabilities, capabilityList } from '../lib/model-capabilities.js'

test('by ID: the families that read images and call tools', () => {
  const both = ['gpt-4o-mini', 'gpt-4.1', 'gpt-5', 'o3', 'claude-sonnet-4-5', 'claude-3-5-haiku-20241022', 'gemini-3.5-flash',
    'gemini-2.5-pro', 'meta-llama/llama-4-scout-17b-16e-instruct', 'pixtral-large-latest', 'grok-4', 'mistral-small-latest']
  for (const id of both) assert.deepEqual(capabilitiesOf(id), { vision: true, tools: true }, id)
  const toolsOnly = ['openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'qwen/qwen3-32b', 'moonshotai/kimi-k2-instruct', 'o3-mini',
    'mistral-large-latest', 'deepseek-chat']
  for (const id of toolsOnly) assert.deepEqual(capabilitiesOf(id), { vision: false, tools: true }, id)
  const neither = ['allam-2-7b', 'gpt-4o-audio-preview', 'gpt-4o-mini-transcribe', 'gemini-2.5-flash-preview-tts',
    'whisper-large-v3', 'llama3.2', 'mock-fast']
  for (const id of neither) assert.deepEqual(capabilitiesOf(id), { vision: false, tools: false }, id)
  assert.deepEqual(capabilitiesOf('qwen/qwen2.5-vl-72b-instruct'), { vision: true, tools: true })
})

test('what providers say: OpenRouter and Mistral', () => {
  assert.deepEqual(capabilityHints({ architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools', 'temperature'] }),
    { vision: true, tools: true })
  assert.deepEqual(capabilityHints({ architecture: { input_modalities: ['text'] }, supported_parameters: ['temperature'] }),
    { vision: false, tools: false })
  assert.deepEqual(capabilityHints({ capabilities: { completion_chat: true, vision: true, function_calling: false } }), { vision: true, tools: false })
  assert.deepEqual(capabilityHints({ id: 'gpt-4o' }), {})
})

test('the organization, then the catalog, then the provider, then the ID; only chat models', () => {
  assert.deepEqual(effectiveCapabilities({ id: 'gpt-4o' }), { vision: true, tools: true })
  assert.deepEqual(effectiveCapabilities({ id: 'gpt-4o', own: { vision: false } }), { vision: false, tools: true })
  assert.deepEqual(effectiveCapabilities({ id: 'mock-fast', catalog: { tools: true }, listed: { tools: false, vision: true } }), { vision: true, tools: true })
  assert.deepEqual(effectiveCapabilities({ id: 'gpt-4o', kind: 'embedding' }), { vision: false, tools: false })
  assert.deepEqual(capabilityList({ vision: true, tools: true }), ['tools', 'vision'])
  assert.deepEqual(capabilityList({ vision: false, tools: true }), ['tools'])
})
