'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { formatCost } from '../../lib/format'

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:8080'

// ─── SSE stream parser ────────────────────────────────────────────────────────

async function* readSSE(response) {
  const reader  = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer    = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() // keep incomplete trailing line
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const raw = line.slice(6).trim()
        if (raw === '[DONE]') return
        try { yield JSON.parse(raw) } catch { /* skip malformed */ }
      }
    }
  }
}

function extractChunk(provider, chunk) {
  // Returns { text, inputTokens, outputTokens }
  if (provider === 'openai') {
    return {
      text:         chunk.choices?.[0]?.delta?.content ?? '',
      inputTokens:  chunk.usage?.prompt_tokens     ?? null,
      outputTokens: chunk.usage?.completion_tokens ?? null,
    }
  }
  if (provider === 'anthropic') {
    return {
      text:         chunk.delta?.text ?? '',
      inputTokens:  chunk.message?.usage?.input_tokens ?? null,
      outputTokens: chunk.usage?.output_tokens          ?? null,
    }
  }
  return { text: '', inputTokens: null, outputTokens: null }
}

// ─── Cost helpers ────────────────────────────────────────────────────────────

function calcCost(model, inputTokens, outputTokens) {
  if (!model || !inputTokens) return null
  const inputCost  = (inputTokens  / 1000) * parseFloat(model.cost_per_1k_input_tokens)
  const outputCost = (outputTokens / 1000) * parseFloat(model.cost_per_1k_output_tokens)
  return inputCost + outputCost
}

// ─── Sub-components ──────────────────────────────────────────────────────────


// ─── Change password modal ────────────────────────────────────────────────────
function ChangePasswordModal({ apiKey, gatewayUrl, onClose }) {
  const [form,    setForm]    = useState({ current: '', next: '', confirm: '' })
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')
  const [success, setSuccess] = useState(false)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function submit() {
    if (!form.current || !form.next) { setError('All fields are required'); return }
    if (form.next !== form.confirm)  { setError('New passwords do not match'); return }
    if (form.next.length < 6)        { setError('Password must be at least 6 characters'); return }

    setSaving(true); setError('')
    try {
      const res  = await fetch(`${gatewayUrl}/auth/change-password`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body:    JSON.stringify({ currentPassword: form.current, newPassword: form.next }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Error'); return }
      setSuccess(true)
    } catch { setError('Connection error') }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-sm bg-card border border-border rounded-2xl shadow-dropdown">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-strong">Change password</h2>
          <button onClick={onClose} className="text-muted hover:text-default text-lg">✕</button>
        </div>
        <div className="px-6 py-5 space-y-3">
          {success ? (
            <div className="text-center space-y-3 py-2">
              <div className="text-2xl">✓</div>
              <p className="text-sm text-strong font-medium">Password updated</p>
              <p className="text-xs text-muted">Your new password is active immediately.</p>
              <button onClick={onClose}
                className="w-full bg-accent hover:bg-accent-hover text-white rounded-lg py-2.5 text-sm font-semibold transition-colors">
                Close
              </button>
            </div>
          ) : (
            <>
              {[
                { k: 'current', label: 'Current password', ph: '••••••••' },
                { k: 'next',    label: 'New password',     ph: 'Min. 6 characters' },
                { k: 'confirm', label: 'Confirm new password', ph: '••••••••' },
              ].map(({ k, label, ph }) => (
                <div key={k}>
                  <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-1.5">{label}</label>
                  <input
                    type="password"
                    placeholder={ph}
                    value={form[k]}
                    onChange={e => set(k, e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && submit()}
                    className="w-full bg-raised border border-border rounded-lg px-3.5 py-2.5 text-sm text-strong focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
                  />
                </div>
              ))}
              {error && <p className="text-xs text-err">{error}</p>}
              <div className="flex gap-2 pt-1">
                <button onClick={onClose}
                  className="flex-1 bg-card border border-border rounded-lg py-2.5 text-sm font-semibold text-muted hover:bg-raised transition-colors">
                  Cancel
                </button>
                <button onClick={submit} disabled={saving}
                  className="flex-1 bg-accent hover:bg-accent-hover disabled:opacity-40 text-white rounded-lg py-2.5 text-sm font-semibold transition-colors">
                  {saving ? 'Saving…' : 'Update password'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

    </div>
  )
}

function LoginForm({ onLogin, error }) {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)

  async function submit() {
    if (!email || !password) return
    setLoading(true)
    await onLogin(email.trim(), password)
    setLoading(false)
  }

  function onKey(e) { if (e.key === 'Enter') submit() }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 px-4">
      <div className="text-center">
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
              <path d="M6 1L11 6L6 11L1 6L6 1Z" fill="white"/>
            </svg>
          </div>
          <span className="font-bold text-strong text-lg">Stratum</span>
        </div>
        <h1 className="text-base font-semibold text-strong">Playground</h1>
        <p className="text-sm text-muted mt-1">Sign in with your corporate account</p>
      </div>
      <div className="w-full max-w-xs space-y-3">
        <input
          type="email"
          placeholder="you@company.com"
          value={email}
          onChange={e => setEmail(e.target.value)}
          onKeyDown={onKey}
          className="w-full bg-card border border-border rounded-lg px-3.5 py-2.5 text-sm text-strong placeholder-subtle focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
          autoFocus
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={onKey}
          className="w-full bg-card border border-border rounded-lg px-3.5 py-2.5 text-sm text-strong placeholder-subtle focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
        />
        {error && <p className="text-xs text-err">{error}</p>}
        <button
          onClick={submit}
          disabled={!email || !password || loading}
          className="w-full bg-accent hover:bg-accent-hover disabled:opacity-40 text-white font-semibold rounded-lg py-2.5 text-sm transition-colors shadow-sm"
        >
          {loading ? 'Signing in…' : 'Continue'}
        </button>
      </div>
      <p className="text-xs text-subtle">Session lasts 24 hours</p>
    </div>
  )
}

function ModelBadge({ model }) {
  const isOpenAI    = model.provider === 'openai'
  const isAnthropic = model.provider === 'anthropic'
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border
      ${isOpenAI    ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800/50' : ''}
      ${isAnthropic ? 'bg-orange-950/60 text-orange-400 border-orange-800/50'   : ''}
    `}>
      {isOpenAI ? 'OpenAI' : isAnthropic ? 'Anthropic' : model.provider}
    </span>
  )
}

function MetaBadge({ inputTokens, outputTokens, cost }) {
  if (!inputTokens && !outputTokens) return null
  return (
    <div className="flex gap-3 mt-2 text-[11px] text-slate-500">
      <span>↑ {inputTokens?.toLocaleString() ?? '—'} tokens</span>
      <span>↓ {outputTokens?.toLocaleString() ?? '—'} tokens</span>
      {cost != null && (
        <span className="text-orange-400 font-semibold">${formatCost(cost)} USD</span>
      )}
    </div>
  )
}

function MessageBubble({ msg }) {
  const isUser = msg.role === 'user'
  const cost = msg.usedModel
    ? calcCost(msg.usedModel, msg.inputTokens, msg.outputTokens)
    : null

  return (
    <div className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
      {/* Attachment previews */}
      {isUser && msg.attachments?.length > 0 && (
        <div className="flex flex-wrap gap-2 justify-end mb-1">
          {msg.attachments.map((f, i) => (
            <div key={i} className="flex items-center gap-1.5 bg-raised border border-border rounded-lg px-2.5 py-1.5 text-xs text-muted">
              {f.preview
                ? <img src={f.preview} alt={f.name} className="w-6 h-6 rounded object-cover" />
                : <span>{f.type === 'application/pdf' ? '📄' : '📎'}</span>}
              <span className="max-w-[120px] truncate">{f.name}</span>
            </div>
          ))}
        </div>
      )}
      <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap
        ${isUser
          ? 'bg-accent text-white rounded-tr-sm shadow-sm'
          : 'bg-card border border-border text-default rounded-tl-sm shadow-card'}`}>
        {typeof msg.content === 'string'
          ? msg.content || (msg.streaming ? <span className="text-muted animate-pulse">···</span> : '')
          : msg.content?.find?.(c => c.type === 'text')?.text ?? ''}
      </div>
      {!isUser && (
        <MetaBadge
          inputTokens={msg.inputTokens}
          outputTokens={msg.outputTokens}
          cost={cost}
        />
      )}
    </div>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function PlaygroundPage() {
  const [apiKey,       setApiKey]       = useState('')
  const [keyError,     setKeyError]     = useState('')
  const [userInfo,     setUserInfo]     = useState(null)
  const [models,       setModels]       = useState([])
  const [selectedId,   setSelectedId]   = useState('')
  const [messages,     setMessages]     = useState([])
  const [input,        setInput]        = useState('')
  const [streaming,    setStreaming]     = useState(false)
  const [attachments,  setAttachments]   = useState([])  // { name, type, base64, textContent, preview }
  const [showChangePwd,  setShowChangePwd]  = useState(false)
  // Use useRef for values read inside useCallback to avoid stale closures
  const [compressCtx,      setCompressCtx]      = useState(false)
  const compressCtxRef                           = useRef(false)
  const [compressing,      setCompressing]       = useState(false)
  const [compressedHistory, _setCompressedHistory] = useState(null)
  const compressedHistoryRef                     = useRef(null)
  const [lastSummary,      setLastSummary]       = useState(null)
  const [compressionStats, setCompressionStats]  = useState({ events: [], totalSaved: 0 })

  // Synced setter — keeps ref and state in sync
  const setCompressedHistory = (val) => {
    compressedHistoryRef.current = val
    _setCompressedHistory(val)
  }

  const bottomRef   = useRef(null)
  const textareaRef = useRef(null)
  const fileRef     = useRef(null)

  // Supported file types
  const ACCEPTED = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.csv,.json'

  const selectedModel = models.find(m => m.model_id === selectedId)

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Load persisted history after login — scoped to current user
  useEffect(() => {
    if (!userInfo) return
    try {
      const storageKey = `stratum_playground_v1_${userInfo.user?.email ?? 'anon'}`
      const saved = localStorage.getItem(storageKey)
      if (!saved) return
      const data = JSON.parse(saved)
      if (data.messages?.length) setMessages(data.messages)
      if (data.selectedModelId)  setSelectedId(data.selectedModelId)
      if (data.compressedHistory) {
        compressedHistoryRef.current = data.compressedHistory
        _setCompressedHistory(data.compressedHistory)
      }
      if (data.compressionStats) setCompressionStats(data.compressionStats)
    } catch (e) { console.warn('Failed to load history:', e.message) }
  }, [userInfo])

  // Auto-save history when messages change — scoped to current user
  useEffect(() => {
    if (!userInfo || streaming || messages.length === 0) return
    try {
      const storageKey = `stratum_playground_v1_${userInfo.user?.email ?? 'anon'}`
      const data = {
        messages:         messages.filter(m => !m.streaming),
        selectedModelId:  selectedId,
        compressedHistory: compressedHistoryRef.current,
        compressionStats,
      }
      localStorage.setItem(storageKey, JSON.stringify(data))
    } catch (e) { console.warn('Failed to save history:', e.message) }
  }, [messages, streaming, compressionStats])

  // Load from session on mount
  useEffect(() => {
    const saved     = sessionStorage.getItem('aig_token')
    const savedUser = sessionStorage.getItem('aig_user')
    if (saved) {
      // Restore session — verify token is still valid via /me
      fetch(`${GATEWAY}/me`, { headers: { Authorization: `Bearer ${saved}` } })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (!data) { sessionStorage.removeItem('aig_token'); return }
          setUserInfo({ user: savedUser ? JSON.parse(savedUser) : {}, team: data.team, policy: data.policy })
          setModels(data.models)
          setSelectedId(data.models[0]?.model_id ?? '')
          setApiKey(saved)
        })
        .catch(() => sessionStorage.removeItem('aig_token'))
    }
  }, [])

  async function handleLogin(email, password) {
    setKeyError('')
    try {
      const res  = await fetch(`${GATEWAY}/auth/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) { setKeyError(data.error ?? 'Credenciales incorrectas'); return }
      setUserInfo({ user: data.user, team: data.team, policy: data.policy })
      setModels(data.models)
      setSelectedId(data.models[0]?.model_id ?? '')
      setApiKey(data.token)
      sessionStorage.setItem('aig_token', data.token)
      sessionStorage.setItem('aig_user',  JSON.stringify(data.user))
    } catch {
      setKeyError('No se pudo conectar al gateway. ¿Está corriendo en :8080?')
    }
  }

  // ── File reading helpers ───────────────────────────────────────────────────
  async function handleFiles(files) {
    const newAttachments = []
    for (const file of Array.from(files)) {
      const isImage = file.type.startsWith('image/')
      const isPdf   = file.type === 'application/pdf'
      const isText  = file.type.startsWith('text/') || ['application/json'].includes(file.type)

      if (isImage || isPdf) {
        const base64 = await new Promise((res, rej) => {
          const r = new FileReader()
          r.onload = () => res(r.result.split(',')[1])
          r.onerror = rej
          r.readAsDataURL(file)
        })
        newAttachments.push({
          name: file.name, type: file.type, base64,
          preview: isImage ? URL.createObjectURL(file) : null,
        })
      } else if (isText) {
        const textContent = await file.text()
        newAttachments.push({ name: file.name, type: file.type, textContent })
      }
    }
    setAttachments(prev => [...prev, ...newAttachments])
  }

  function removeAttachment(i) {
    setAttachments(prev => prev.filter((_, idx) => idx !== i))
  }

  // Build message content with attachments for each provider
  function buildContent(text, files, provider) {
    if (!files.length) return text
    const parts = []
    for (const f of files) {
      if (provider === 'anthropic') {
        if (f.type === 'application/pdf') {
          parts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.base64 } })
        } else if (f.type.startsWith('image/')) {
          parts.push({ type: 'image', source: { type: 'base64', media_type: f.type, data: f.base64 } })
        } else {
          parts.push({ type: 'text', text: `[${f.name}]\n${f.textContent}` })
        }
      } else {
        // OpenAI-compatible
        if (f.type.startsWith('image/')) {
          parts.push({ type: 'image_url', image_url: { url: `data:${f.type};base64,${f.base64}` } })
        } else if (f.type === 'application/pdf') {
          parts.push({ type: 'text', text: `[PDF: ${f.name} — PDF not supported by this provider. Ask Anthropic instead.]` })
        } else {
          parts.push({ type: 'text', text: `[${f.name}]\n${f.textContent}` })
        }
      }
    }
    if (text) parts.push({ type: 'text', text })
    return parts
  }

  // ── Context compression ───────────────────────────────────────────────────

  // ── Context compression + send ───────────────────────────────────────────
  // Plain async function (no useCallback) — eliminates all stale closure bugs.
  // Reads compressedHistoryRef and compressCtxRef directly (always current).
  //
  // Thresholds:
  //   FIRST_COMPRESS : call Ollama when conversation first reaches this many messages
  //   RECOMPRESS_AFTER: call Ollama again only when this many NEW messages accumulate
  //   KEEP_RECENT    : always keep this many recent messages uncompressed

  const FIRST_COMPRESS   = 6   // first compression at 6 messages (3 full exchanges)
  const RECOMPRESS_AFTER = 10  // re-compress after 10 recent messages (keeps 4 + needs 3 more exchanges)
  const KEEP_RECENT      = 4   // always send the last 4 messages fresh to the provider

  async function handleSend() {
    if (!input.trim() || streaming || !selectedModel) return

    const provider   = selectedModel?.provider ?? 'openai'
    const msgContent = buildContent(input.trim(), attachments, provider)
    const userMsg    = { role: 'user', content: msgContent }
    const userDisplay = { role: 'user', content: input.trim(), attachments: [...attachments] }

    // ── Decide context to send ────────────────────────────────────────────
    let baseMessages = messages

    if (compressCtxRef.current) {
      const recentMsgs = messages.filter(m => !m.isSummary && !m.streaming)
      const hasSummary = !!compressedHistoryRef.current

      const needsFirstCompress = !hasSummary && recentMsgs.length >= FIRST_COMPRESS
      const needsRecompress    =  hasSummary && recentMsgs.length >= RECOMPRESS_AFTER

      if (needsFirstCompress || needsRecompress) {
        // ── Call Ollama ─────────────────────────────────────────────────
        const toCompress = needsRecompress
          ? [...compressedHistoryRef.current, ...recentMsgs.slice(0, recentMsgs.length - KEEP_RECENT)]
          : recentMsgs.slice(0, recentMsgs.length - KEEP_RECENT)
        const toKeep = recentMsgs.slice(recentMsgs.length - KEEP_RECENT)

        setCompressing(true)
        try {
          const res  = await fetch('/api/compress-context', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ messages: toCompress }),
          })
          const data = await res.json()

          if (res.ok && data.summary) {
            const summaryMsg = {
              role: 'user',
              content: `[Context summary]
${data.summary}`,
              isSummary: true,
            }
            const ackMsg = {
              role: 'assistant',
              content: 'Context summary received.',
              isSummary: true,
            }
            const newHistory = [summaryMsg, ackMsg]
            compressedHistoryRef.current = newHistory
            _setCompressedHistory(newHistory)
            // Estimate token savings (4 chars ≈ 1 token)
            const estOriginal = toCompress.reduce((acc, m) => {
              const txt = typeof m.content === 'string' ? m.content
                : m.content?.find?.(c => c.type === 'text')?.text ?? ''
              return acc + Math.ceil(txt.length / 4)
            }, 0)
            const estSummary = Math.ceil(data.summary.length / 4)
            const savedTk    = Math.max(0, estOriginal - estSummary)
            setCompressionStats(prev => ({
              events: [...prev.events, { compressed: toCompress.length, savedTokens: savedTk, ts: Date.now() }],
              totalSaved: prev.totalSaved + savedTk,
            }))
            setLastSummary({ original: toCompress.length, summary: data.summary, model: data.model })
            baseMessages = [...newHistory, ...toKeep]
            setMessages(baseMessages)
          } else {
            console.warn('[compress] failed:', data?.message ?? 'no summary')
            // Fall through with full context
          }
        } catch (err) {
          console.warn('[compress] error:', err.message)
        } finally {
          setCompressing(false)
        }

      } else if (hasSummary) {
        // ── Fast path: reuse existing summary, zero Ollama calls ─────────
        baseMessages = [...compressedHistoryRef.current, ...recentMsgs]
      }
      // else: compression ON but threshold not reached yet → send full context
    }

    // Strip display-only fields before sending to provider
    const history = [...baseMessages, userMsg].map(({ role, content }) => ({ role, content }))

    setMessages(prev => [...prev, userDisplay, { role: 'assistant', content: '', streaming: true }])
    setInput('')
    setAttachments([])
    setStreaming(true)

    try {
      // Use the model's actual provider slug in the URL so custom providers
      // (bonsai, ollama, groq, etc.) route through their own proxy config
      const isAnthropic = selectedModel.provider === 'anthropic'
      const ep = isAnthropic
        ? `${GATEWAY}/proxy/${selectedModel.provider}/v1/messages`
        : `${GATEWAY}/proxy/${selectedModel.provider}/v1/chat/completions`

      const body = isAnthropic
        ? { model: selectedModel.model_id, max_tokens: 1024, stream: true, messages: history }
        : { model: selectedModel.model_id, stream: true, stream_options: { include_usage: true }, messages: history }

      const res = await fetch(ep, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body:    JSON.stringify(body),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }))
        const friendly = {
          429: '⏱ Rate limit o budget agotado.',
          403: `🚫 Acceso denegado: ${err?.message ?? 'modelo no permitido'}`,
          401: '🔑 API key inválida.',
          400: `⚠️ Request inválido: ${err?.message ?? err?.error?.message ?? 'revisá el modelo'}`,
          502: '🔌 No se pudo conectar con el proveedor.',
        }
        setMessages(prev => {
          const next = [...prev]
          next[next.length - 1] = {
            role: 'assistant',
            content: friendly[res.status] ?? `❌ Error ${res.status}: ${err?.message}`,
            streaming: false,
          }
          return next
        })
        return
      }

      // Stream response
      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = '', fullText = '', inputTokens = null, outputTokens = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') continue
          try {
            const evt = JSON.parse(raw)
            if (selectedModel.provider === 'anthropic') {
              if (evt.type === 'content_block_delta') fullText += evt.delta?.text ?? ''
              if (evt.type === 'message_start')       inputTokens  = evt.message?.usage?.input_tokens
              if (evt.type === 'message_delta')       outputTokens = evt.usage?.output_tokens
            } else {
              fullText += evt.choices?.[0]?.delta?.content ?? ''
              if (evt.usage) {
                inputTokens  = evt.usage.prompt_tokens
                outputTokens = evt.usage.completion_tokens
              }
            }
            setMessages(prev => {
              const next = [...prev]
              next[next.length - 1] = {
                role: 'assistant', content: fullText, streaming: true,
                inputTokens, outputTokens, usedModel: selectedModel,
              }
              return next
            })
          } catch {}
        }
      }

      setMessages(prev => {
        const next = [...prev]
        next[next.length - 1] = {
          role: 'assistant', content: fullText, streaming: false,
          inputTokens, outputTokens, usedModel: selectedModel,
        }
        return next
      })

    } catch (err) {
      setMessages(prev => {
        const next = [...prev]
        next[next.length - 1] = { role: 'assistant', content: `❌ ${err.message}`, streaming: false }
        return next
      })
    } finally {
      setStreaming(false)
      textareaRef.current?.focus()
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function clearChat() {
    setMessages([])
    setInput('')
    setAttachments([])
    compressedHistoryRef.current = null
    _setCompressedHistory(null)
    setLastSummary(null)
    setCompressionStats({ events: [], totalSaved: 0 })
    const storageKey = `stratum_playground_v1_${userInfo?.user?.email ?? 'anon'}`
    localStorage.removeItem(storageKey)
  }

  function logout() {
    sessionStorage.removeItem('aig_token'); sessionStorage.removeItem('aig_user')
    setUserInfo(null)
    setApiKey('')
    setMessages([])
    setInput('')
    setAttachments([])
    compressedHistoryRef.current = null
    _setCompressedHistory(null)
    setLastSummary(null)
  }

  // ── Render: key setup ──────────────────────────────────────────────────────
  if (!userInfo) {
    return <LoginForm onLogin={handleLogin} error={keyError} />
  }

  // ── Render: playground ────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen">

      {/* Top bar */}
      <header className="flex items-center justify-between px-5 h-14 border-b border-border bg-card flex-shrink-0 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 rounded-md bg-accent flex items-center justify-center">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 1L11 6L6 11L1 6L6 1Z" fill="white"/>
            </svg>
          </div>
          <span className="font-semibold text-strong text-sm">Playground</span>
          <span className="text-xs text-muted">{userInfo.team?.name ?? '—'} · {userInfo.policy?.name ?? '—'}</span>
        </div>

        <div className="flex items-center gap-3">
          {/* Admin button — Engineering team only */}
          {userInfo.team?.name === 'Engineering' && (
            <button
              onClick={() => window.location.href = '/'}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-border text-muted hover:text-default hover:bg-raised transition-colors"
              title="Go to admin dashboard"
            >
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <rect x="1" y="1" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.2"/>
                <rect x="6" y="1" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.2"/>
                <rect x="1" y="6" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.2"/>
                <rect x="6" y="6" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
              Admin
            </button>
          )}
          <div className="flex items-center gap-3">
            <select
              value={selectedId}
              onChange={e => setSelectedId(e.target.value)}
              disabled={streaming}
              className="bg-card border border-border rounded-lg px-3 py-1.5 text-sm text-strong focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent disabled:opacity-50"
            >
              {models.map(m => (
                <option key={m.model_id} value={m.model_id}>{m.display_name}</option>
              ))}
            </select>
            {selectedModel && (
              <span className="text-xs text-muted border border-border rounded-full px-2 py-0.5">
                {selectedModel.provider}
              </span>
            )}
            <button
              onClick={clearChat}
              disabled={!messages.length || streaming}
              className="text-xs text-muted hover:text-default disabled:opacity-30 transition-colors"
            >
              Clear
            </button>
            {/* Context compression toggle */}
            <button
              onClick={() => {
                const next = !compressCtxRef.current
                compressCtxRef.current = next
                setCompressCtx(next)
                if (!next) { setCompressedHistory(null); setLastSummary(null) }
              }}
              title={compressCtx ? 'Context compression ON — click to disable' : 'Context compression OFF — click to enable'}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                compressCtx
                  ? 'bg-accent-light border-accent/30 text-accent-text font-medium'
                  : 'border-border text-muted hover:text-default'
              }`}
            >
              {compressing
                ? <span className="animate-pulse">⟳</span>
                : <span>⬡</span>}
              <span>Compress</span>
            </button>

            <button
              onClick={() => setShowChangePwd(true)}
              className="text-xs text-muted hover:text-default transition-colors"
              title="Change password"
            >
              ⚙
            </button>
            <button
              onClick={logout}
              className="text-xs text-muted hover:text-default transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-5">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-2">
            <p className="text-sm text-muted">Type a message to start</p>
            {selectedModel && (
              <p className="text-xs text-subtle">{selectedModel.display_name}</p>
            )}
          </div>
        )}

        <div className="max-w-3xl mx-auto space-y-5 w-full">
          {messages.map((msg, i) => (
            <MessageBubble key={i} msg={msg} />
          ))}
        </div>

        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      {/* Compression panel — shows when compress is ON */}
      {compressCtx && (
        <div className="flex-shrink-0 border-t border-border bg-raised px-4 py-2.5">
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-4 flex-wrap">
            {/* Left: live context info */}
            {(() => {
              const recentMsgs  = messages.filter(m => !m.isSummary && !m.streaming)
              const hasSummary  = !!compressedHistoryRef.current
              const nextIn      = hasSummary
                ? Math.max(0, RECOMPRESS_AFTER - recentMsgs.length)
                : Math.max(0, FIRST_COMPRESS - recentMsgs.length)
              return (
                <div className="flex items-center gap-4 text-xs text-muted">
                  <span className="flex items-center gap-1.5">
                    <span className="text-accent font-semibold">⬡</span>
                    <span>Compress activo</span>
                  </span>
                  <span>
                    <span className="font-medium text-default">{recentMsgs.length}</span>
                    {' '}mensajes en contexto
                  </span>
                  {nextIn > 0 ? (
                    <span className="text-subtle">próxima compresión en {nextIn} mensaje{nextIn !== 1 ? 's' : ''}</span>
                  ) : compressing ? (
                    <span className="text-accent animate-pulse">comprimiendo…</span>
                  ) : (
                    <span className="text-ok font-medium">umbral alcanzado</span>
                  )}
                </div>
              )
            })()}

            {/* Right: savings summary (only when compressions occurred) */}
            {compressionStats.events.length > 0 && (() => {
              const totalOrig  = compressionStats.events.reduce((a, e) => a + e.savedTokens + Math.ceil(e.compressed * 30), 0)
              const pct        = totalOrig > 0 ? Math.round((compressionStats.totalSaved / totalOrig) * 100) : 0
              return (
                <div className="flex items-center gap-3 text-xs flex-shrink-0">
                  <span className="text-muted">
                    ~<span className="font-medium text-ok">{compressionStats.totalSaved.toLocaleString()}</span> tokens ahorrados
                    · <span className="font-medium text-default">{compressionStats.events.length}</span> compresion{compressionStats.events.length !== 1 ? 'es' : ''}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <div className="w-20 h-1.5 bg-border rounded-full overflow-hidden">
                      <div className="h-full bg-ok rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-ok font-semibold">{pct}%</span>
                  </div>
                </div>
              )
            })()}
          </div>
        </div>
      )}

      <div className="flex-shrink-0 border-t border-border bg-card px-4 py-4">
        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="max-w-3xl mx-auto flex flex-wrap gap-2 mb-2">
            {attachments.map((f, i) => (
              <div key={i} className="flex items-center gap-1.5 bg-raised border border-border rounded-lg px-2.5 py-1 text-xs text-muted">
                {f.preview
                  ? <img src={f.preview} alt={f.name} className="w-5 h-5 rounded object-cover" />
                  : <span>{f.type === 'application/pdf' ? '📄' : '📎'}</span>}
                <span className="max-w-[140px] truncate">{f.name}</span>
                <button onClick={() => removeAttachment(i)} className="text-subtle hover:text-err ml-0.5">✕</button>
              </div>
            ))}
          </div>
        )}

        <div className="max-w-3xl mx-auto flex gap-2 items-end">
          {/* File upload */}
          <input ref={fileRef} type="file" multiple accept={ACCEPTED} className="hidden"
            onChange={e => handleFiles(e.target.files)} />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={streaming}
            className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-xl border border-border bg-card hover:bg-raised text-muted hover:text-default transition-colors disabled:opacity-40"
            title="Attach file"
          >
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
              <path d="M13.5 6.5L7 13a4 4 0 01-5.657-5.657l6.5-6.5a2.5 2.5 0 013.536 3.536L5 11a1 1 0 01-1.414-1.414L9.5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>

          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); handleFiles(e.dataTransfer.files) }}
            placeholder="Message… (Enter to send, Shift+Enter for new line)"
            rows={1}
            disabled={streaming}
            className="flex-1 bg-raised border border-border rounded-xl px-4 py-3 text-sm text-strong placeholder-subtle focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent resize-none disabled:opacity-50 transition-all"
            style={{ minHeight: 48, maxHeight: 160, overflowY: 'auto' }}
            onInput={e => {
              e.target.style.height = 'auto'
              e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'
            }}
          />
          <button
            onClick={handleSend}
            disabled={(!input.trim() && !attachments.length) || streaming}
            className="bg-accent hover:bg-accent-hover disabled:opacity-40 text-white rounded-xl px-4 py-3 text-sm font-semibold transition-colors flex-shrink-0 shadow-sm"
          >
            {streaming ? '…' : '↑'}
          </button>
        </div>
        <div className="max-w-3xl mx-auto mt-2 text-center text-xs text-subtle">
          {compressing
            ? '⟳ Compressing context with local model…'
            : streaming
              ? 'Generating…'
              : lastSummary && compressCtx
                ? `Context compression active · last compressed ${lastSummary.original} messages → 1 summary`
                : 'Multi-turn · model remembers context · attach files with 📎 or drag & drop'}
        </div>
      </div>

      {showChangePwd && (
        <ChangePasswordModal
          apiKey={apiKey}
          gatewayUrl={GATEWAY}
          onClose={() => setShowChangePwd(false)}
        />
      )}
    </div>
  )
}
