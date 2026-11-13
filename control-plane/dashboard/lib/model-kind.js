/**
 * lib/model-kind.js — what kind of model each one is: chat, embeddings,
 * images, speech to text, text to speech, moderation, or other.
 *
 * Providers list chat models next to everything else (whisper, tts-1,
 * text-embedding-3-small, dall-e-3, ...), and a chat picker should offer
 * only chat models. A model's kind is, in this order:
 *
 *   1. the organization's own choice (Modelos → the model's kind);
 *   2. the catalog's (catalog/models.json "kind");
 *   3. what the provider said when it listed it (Mistral's capabilities,
 *      Together's type, OpenRouter's output modalities);
 *   4. its ID (kindOf below), which covers the providers that say nothing:
 *      OpenAI, Groq, Gemini's OpenAI-compatible list, xAI.
 *
 * The kind travels to gateways with the model list (GET /v1/models says it),
 * so an application, the Enterprise portal for one, can offer chat models
 * in a chat and the others where they belong.
 */

export const KINDS = Object.freeze(['chat', 'embedding', 'image', 'transcription', 'speech', 'moderation', 'other'])

export const KIND_LABELS = Object.freeze({
  chat: 'Chat',
  embedding: 'Embeddings',
  image: 'Imágenes',
  transcription: 'Voz a texto',
  speech: 'Texto a voz',
  moderation: 'Moderación',
  other: 'Otro',
})

export const isKind = v => typeof v === 'string' && KINDS.includes(v)

// By ID, first match wins: the specific ones before the general ones
// ("gpt-4o-mini-transcribe" is not chat, "gemini-2.5-flash-preview-tts" is
// not chat, "omni-moderation-latest" is not chat).
const RULES = [
  ['moderation', /moderation|llama-guard|prompt-guard|shieldgemma|(^|[/-])guard($|[-:])/],
  ['transcription', /whisper|transcribe|speech-to-text|(^|[/-])stt($|[-:])/],
  ['speech', /(^|[/-])tts($|[-:])|text-to-speech|orpheus|playai|sonic-|(^|[/-])speech($|[-:])/],
  ['embedding', /embed|(^|[/-])bge-|(^|[/-])e5-|(^|[/-])gte-/],
  ['image', /dall-e|gpt-image|imagen|image-generation|-image($|[-:])|flux|stable-diffusion|sdxl|recraft|ideogram/],
  ['other', /realtime|native-audio|(^|[/-])veo-|sora|rerank|(^|[/-])live-|computer-use|(^|[/-])aqa$|^(babbage|davinci)-\d+$/],
]

/** The kind of a model by its ID alone ("chat" when nothing says otherwise). */
export function kindOf(id) {
  const name = String(id ?? '').toLowerCase()
  for (const [kind, re] of RULES) if (re.test(name)) return kind
  return 'chat'
}

const TOGETHER = { chat: 'chat', language: 'chat', code: 'chat', embedding: 'embedding', image: 'image',
  audio: 'speech', transcribe: 'transcription', moderation: 'moderation', rerank: 'other', video: 'other' }

/**
 * What a provider's model list says about one entry, or null when it says
 * nothing (most do not): Mistral's "capabilities", Together's "type",
 * OpenRouter's "architecture".
 */
export function kindHint(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (typeof entry.type === 'string' && Object.hasOwn(TOGETHER, entry.type)) return TOGETHER[entry.type]
  const caps = entry.capabilities
  if (caps && typeof caps === 'object' && typeof caps.completion_chat === 'boolean') {
    if (caps.completion_chat) return 'chat'
    const id = String(entry.id ?? '')
    if (caps.classification || /moderation/i.test(id)) return 'moderation'
    if (/embed/i.test(id)) return 'embedding'
    if (/transcri|voxtral/i.test(id)) return 'transcription'
    return 'other'
  }
  const out = entry.architecture?.output_modalities
  if (Array.isArray(out) && out.length) {
    if (out.includes('image')) return 'image'
    if (out.includes('audio') && !out.includes('text')) return 'speech'
    if (out.includes('text')) return null // a chat model, or one its ID says more about
  }
  return null
}

/**
 * The kind a model has for the organization: its own choice, the catalog's,
 * the provider's, or by ID.
 */
export function effectiveKind({ own, catalog, listed, id }) {
  for (const k of [own, catalog, listed]) if (isKind(k)) return k
  return kindOf(id)
}
