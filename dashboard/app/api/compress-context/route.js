export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://ollama:11434'
const MODEL      = process.env.OLLAMA_MODEL ?? 'llama3.2:1b'

const SYSTEM_PROMPT = `You are a conversation summarizer. Create a concise summary of the conversation below.

Rules:
- Maximum 4 sentences
- Preserve all important context: decisions, facts, code, topics discussed
- Write in third person: "The user asked about X. The assistant explained Y."
- Include any unresolved questions or pending items
- Respond with ONLY the summary, no preamble`

export async function POST(req) {
  const { messages } = await req.json()

  if (!messages?.length) {
    return NextResponse.json({ error: 'No messages provided' }, { status: 400 })
  }

  const conversation = messages
    .map(m => {
      const role    = m.role === 'user' ? 'User' : 'Assistant'
      const text    = typeof m.content === 'string'
        ? m.content
        : m.content?.find?.(c => c.type === 'text')?.text ?? '[attachment]'
      return `${role}: ${text}`
    })
    .join('\n\n')

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:      MODEL,
        stream:     false,
        keep_alive: -1,        // ← keep model loaded after this call (overrides default)
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: `Summarize:\n\n${conversation}` },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({
        error:   'ollama_error',
        message: `Ollama ${res.status}: ${err.slice(0, 200)}`,
      }, { status: 502 })
    }

    const data    = await res.json()
    const summary = data.message?.content?.trim()

    if (!summary) {
      return NextResponse.json({ error: 'Empty response from model' }, { status: 500 })
    }

    return NextResponse.json({ summary, model: MODEL, inputMessages: messages.length })

  } catch (err) {
    const isTimeout = err.name === 'TimeoutError'
    const isRefused = err.code === 'ECONNREFUSED'
    return NextResponse.json({
      error:   isRefused ? 'ollama_unavailable' : isTimeout ? 'ollama_timeout' : 'compression_failed',
      message: isRefused
        ? 'Ollama is not running. Run: docker compose up ollama'
        : isTimeout
          ? 'Model still loading — try again in a few seconds'
          : err.message,
    }, { status: 502 })
  }
}
