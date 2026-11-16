/**
 * lib/model-capabilities.js — what a chat model can do besides text: read
 * images (vision) and call tools (tools).
 *
 * An application needs to know before it asks: the Enterprise portal does
 * not send an image to a model that cannot read it, and offers MCP tools
 * only with a model that can call them. Each one is, in this order:
 *
 *   1. the organization's own choice (Modelos);
 *   2. the catalog's (catalog/models.json "vision", "tools");
 *   3. what the provider said when it listed the model (OpenRouter's input
 *      modalities and supported parameters, Mistral's capabilities);
 *   4. its ID (below), for the providers that say nothing: OpenAI, Groq,
 *      Gemini's OpenAI-compatible list, Anthropic, xAI.
 *
 * Only chat models have them. They travel to gateways with the model list
 * (GET /v1/models "capabilities": ["tools", "vision"]).
 */

export const CAPABILITIES = Object.freeze(['vision', 'tools'])

export const CAPABILITY_LABELS = Object.freeze({ vision: 'Lee imágenes', tools: 'Usa herramientas' })

// What is not a chat model even when its kind did not say: audio, search,
// realtime and image variants of chat families.
const NOT_CHAT = /audio|realtime|transcribe|tts|search-preview|-image|embedding|moderation|whisper|guard/

// By ID. Families that read images and call tools as of late 2026; the
// organization corrects a model in Modelos when its ID says wrong.
const VISION = [
  /gpt-4o|chatgpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|(^|\/)o[134]($|-(?!mini$))|o4-mini/,
  /claude-(3|sonnet|opus|haiku)/,
  /gemini|gemma-3/,
  /llama-4|llama-3\.2-\d+b-vision|vision|(^|[-/])vl($|[-:])|-vl-|llava|pixtral|moondream|minicpm-v/,
  /grok-(4|2-vision)|mistral-(small|medium)-(3|2503|2505|latest)/,
]
const TOOLS = [
  /gpt-(3\.5|4|5)|chatgpt|(^|\/)o[134]($|-)/,
  /claude-(3|sonnet|opus|haiku)/,
  /gemini/,
  /mistral-(large|medium|small)|ministral|magistral|codestral|pixtral|mixtral/,
  /llama-3\.[123]|llama-4|qwen|gpt-oss|deepseek-(chat|v3)|kimi|glm-4|grok|command-(r|a)/,
]

/** What a model can do by its ID alone. */
export function capabilitiesOf(id) {
  const name = String(id ?? '').toLowerCase()
  if (NOT_CHAT.test(name)) return { vision: false, tools: false }
  return { vision: VISION.some(re => re.test(name)), tools: TOOLS.some(re => re.test(name)) }
}

/**
 * What a provider's model list says about one entry: { vision?, tools? },
 * each only when it says something.
 */
export function capabilityHints(entry) {
  const out = {}
  if (!entry || typeof entry !== 'object') return out
  const input = entry.architecture?.input_modalities
  if (Array.isArray(input) && input.length) out.vision = input.includes('image')
  if (Array.isArray(entry.supported_parameters)) out.tools = entry.supported_parameters.includes('tools')
  const caps = entry.capabilities
  if (caps && typeof caps === 'object' && !Array.isArray(caps)) {
    if (typeof caps.vision === 'boolean') out.vision = caps.vision
    if (typeof caps.function_calling === 'boolean') out.tools = caps.function_calling
  }
  return out
}

const bool = v => (typeof v === 'boolean' ? v : null)

/**
 * What a model can do for the organization: { vision, tools }, each from
 * the first source that says. kind other than chat: nothing.
 */
export function effectiveCapabilities({ own = {}, catalog = {}, listed = {}, id, kind = 'chat' }) {
  if (kind !== 'chat') return { vision: false, tools: false }
  const byId = capabilitiesOf(id)
  const out = {}
  for (const c of CAPABILITIES) {
    out[c] = [own?.[c], catalog?.[c], listed?.[c]].map(bool).find(v => v !== null) ?? byId[c]
  }
  return out
}

/** As GET /v1/models says them: ["tools", "vision"], sorted. */
export const capabilityList = caps => CAPABILITIES.filter(c => caps?.[c]).sort()
