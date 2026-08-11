'use client'

import { useState, useEffect, useCallback } from 'react'
import Modal, { Field, Input, Select, Btn } from '../../components/Modal'

const API_TYPES = [
  { value: 'openai-compatible', label: 'OpenAI-compatible (GPT, Llama, Gemini, Groq…)' },
  { value: 'anthropic',         label: 'Anthropic (Claude)' },
  { value: 'aws-bedrock',       label: 'AWS Bedrock (coming soon)' },
]

function ProviderModal({ onSave, onClose }) {
  const [form, setForm] = useState({
    slug: '', displayName: '', baseUrl: '',
    apiType: 'openai-compatible', apiKeyEnv: '', authHeader: '', notes: '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function submit() {
    if (!form.slug || !form.displayName || !form.baseUrl || !form.apiKeyEnv) {
      setError('All required fields must be filled'); return
    }
    setSaving(true); setError('')
    try {
      const res  = await fetch('/api/providers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Error'); return }
      onSave(data)
    } catch { setError('Connection error') }
    finally { setSaving(false) }
  }

  return (
    <Modal title="Add provider" onClose={onClose} width="max-w-xl">
      <div className="space-y-4">
        <div className="bg-accent-light border border-accent/20 rounded-lg p-3 text-xs text-accent-text">
          After adding a provider, add the API key to your <code className="font-mono">.env</code> file
          using the env var name you specify below, then rebuild the proxy container.
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Slug *" hint="Unique identifier, e.g. groq">
            <Input placeholder="groq" value={form.slug}
              onChange={e => set('slug', e.target.value.toLowerCase().replace(/\s/g, '-'))} />
          </Field>
          <Field label="Display name *">
            <Input placeholder="Groq" value={form.displayName}
              onChange={e => set('displayName', e.target.value)} />
          </Field>
        </div>

        <Field label="Base URL *" hint="Without trailing slash">
          <Input placeholder="https://api.groq.com/openai" value={form.baseUrl}
            onChange={e => set('baseUrl', e.target.value)} />
        </Field>

        <Field label="API type *">
          <Select value={form.apiType} onChange={e => set('apiType', e.target.value)}>
            {API_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="API key env var *" hint="Name of the env var in .env">
            <Input placeholder="GROQ_API_KEY" value={form.apiKeyEnv}
              onChange={e => set('apiKeyEnv', e.target.value.toUpperCase().replace(/\s/g, '_'))} />
          </Field>
          <Field label="Auth header" hint="Leave empty for Bearer token">
            <Input placeholder="x-api-key" value={form.authHeader}
              onChange={e => set('authHeader', e.target.value)} />
          </Field>
        </div>

        <Field label="Notes">
          <Input placeholder="Supported models, special config, etc." value={form.notes}
            onChange={e => set('notes', e.target.value)} />
        </Field>

        {error && <p className="text-xs text-err">{error}</p>}
        <div className="flex gap-2 pt-1">
          <Btn variant="secondary" onClick={onClose} className="flex-1">Cancel</Btn>
          <Btn onClick={submit} disabled={saving} className="flex-1">
            {saving ? 'Saving…' : 'Add provider'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

function StatusDot({ active }) {
  return (
    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${active ? 'bg-ok' : 'bg-border-strong'}`} />
  )
}

export default function ProvidersPage() {
  const [providers, setProviders] = useState([])
  const [loading,   setLoading]   = useState(true)
  const [modal,     setModal]     = useState(false)
  const [toggling,  setToggling]  = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const data = await fetch('/api/providers').then(r => r.json())
    setProviders(data); setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function toggle(p) {
    setToggling(p.id)
    await fetch(`/api/providers/${p.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !p.is_active }),
    })
    setToggling(null); load()
  }

  async function del(p) {
    if (!confirm(`Delete "${p.display_name}"?`)) return
    const res  = await fetch(`/api/providers/${p.id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) { alert(data.error); return }
    load()
  }

  const active   = providers.filter(p =>  p.is_active)
  const inactive = providers.filter(p => !p.is_active)

  return (
    <div className="px-8 py-6 max-w-screen-xl space-y-6">

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-strong">Providers</h1>
          <p className="text-sm text-muted mt-0.5">
            {active.length} active · {inactive.length} inactive
          </p>
        </div>
        <Btn onClick={() => setModal(true)}>+ Add provider</Btn>
      </div>

      {/* Active */}
      {active.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-muted uppercase tracking-widest mb-3">Active</div>
          <div className="space-y-3">
            {active.map(p => (
              <ProviderCard key={p.id} provider={p} onToggle={toggle} onDelete={del} toggling={toggling} />
            ))}
          </div>
        </div>
      )}

      {/* Inactive / available */}
      {inactive.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-muted uppercase tracking-widest mb-3">
            Available — not enabled
          </div>
          <div className="space-y-3">
            {inactive.map(p => (
              <ProviderCard key={p.id} provider={p} onToggle={toggle} onDelete={del} toggling={toggling} />
            ))}
          </div>
        </div>
      )}

      {/* How to add */}
      <div className="bg-card border border-border rounded-xl shadow-card p-5">
        <div className="text-xs font-semibold text-muted uppercase tracking-widest mb-3">
          How to enable a provider
        </div>
        <div className="grid grid-cols-3 gap-5 text-xs text-muted">
          <div>
            <div className="text-default font-semibold mb-1">1. Get an API key</div>
            Create an account with the provider and generate an API key.
          </div>
          <div>
            <div className="text-default font-semibold mb-1">2. Add to .env</div>
            Add <code className="font-mono text-accent-text">PROVIDER_API_KEY=sk-...</code> to your{' '}
            <code className="font-mono">.env</code> file. The env var name is shown on each provider card.
          </div>
          <div>
            <div className="text-default font-semibold mb-1">3. Enable & rebuild</div>
            Click "Enable" on the provider card, then rebuild the proxy:
            {' '}<code className="font-mono text-accent-text">docker compose up --build proxy</code>
          </div>
        </div>
      </div>

      {modal && (
        <ProviderModal onSave={() => { setModal(false); load() }} onClose={() => setModal(false)} />
      )}
    </div>
  )
}

function ProviderCard({ provider: p, onToggle, onDelete, toggling }) {
  const isBuiltIn = ['openai', 'anthropic'].includes(p.slug)

  return (
    <div className={`bg-card border rounded-xl shadow-card overflow-hidden transition-opacity
      ${!p.is_active ? 'opacity-60' : ''} border-border`}>
      <div className="px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <StatusDot active={p.is_active} />
          <div>
            <div className="font-semibold text-strong text-sm">{p.display_name}</div>
            <div className="text-xs text-muted mt-0.5 font-mono">{p.base_url}</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs bg-raised border border-border rounded-full px-2.5 py-1 text-muted font-mono">
            {p.api_key_env}
          </span>
          <span className="text-xs text-subtle">{p.api_type}</span>
          <button
            onClick={() => onToggle(p)}
            disabled={toggling === p.id}
            className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-40
              ${p.is_active
                ? 'border-border text-muted hover:text-err hover:border-err/30'
                : 'border-accent/30 text-accent-text bg-accent-light hover:bg-accent hover:text-white'}`}
          >
            {toggling === p.id ? '…' : p.is_active ? 'Disable' : 'Enable'}
          </button>
          {!isBuiltIn && (
            <button onClick={() => onDelete(p)}
              className="text-xs text-subtle hover:text-err transition-colors">
              Delete
            </button>
          )}
        </div>
      </div>
      {p.notes && (
        <div className="px-5 pb-3.5 text-xs text-muted border-t border-border pt-3">
          {p.notes}
        </div>
      )}
    </div>
  )
}
