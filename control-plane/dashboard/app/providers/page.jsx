'use client'

import { useState, useEffect, useCallback } from 'react'
import Modal, { Field, Input, Select, Btn } from '../../components/Modal'

const API_TYPES = ['openai-compatible', 'anthropic', 'aws-bedrock']

// ── Add Model modal ───────────────────────────────────────────────────────────
function AddModelModal({ provider, onSave, onClose }) {
  const [form, setForm] = useState({ modelId: '', displayName: '', inputCost: '', outputCost: '' })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function submit() {
    if (!form.modelId || !form.displayName) return setError('Model ID y nombre son requeridos')
    setSaving(true); setError('')
    try {
      const res = await fetch(`/api/providers/${provider.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          addModel: {
            modelId:     form.modelId.trim(),
            displayName: form.displayName.trim(),
            inputCost:   parseFloat(form.inputCost)  || 0,
            outputCost:  parseFloat(form.outputCost) || 0,
          }
        }),
      })
      if (!res.ok) { const d = await res.json(); setError(d.error ?? 'Error'); return }
      onSave()
    } catch { setError('Error de conexión') }
    finally { setSaving(false) }
  }

  return (
    <Modal title={`Agregar modelo — ${provider.display_name}`} onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Model ID *" hint="Ej: gpt-4o-mini, gemini-3.6-flash">
            <Input placeholder="model-id-exacto" value={form.modelId}
              onChange={e => set('modelId', e.target.value)} autoFocus />
          </Field>
          <Field label="Nombre visible *">
            <Input placeholder="GPT-4o Mini" value={form.displayName}
              onChange={e => set('displayName', e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Costo input ($/1K tokens)" hint="0 para modelos locales">
            <Input type="number" step="0.000001" placeholder="0.00150" value={form.inputCost}
              onChange={e => set('inputCost', e.target.value)} />
          </Field>
          <Field label="Costo output ($/1K tokens)">
            <Input type="number" step="0.000001" placeholder="0.00600" value={form.outputCost}
              onChange={e => set('outputCost', e.target.value)} />
          </Field>
        </div>
        {error && <p className="text-xs text-err">{error}</p>}
        <div className="flex gap-3">
          <Btn variant="secondary" onClick={onClose} className="flex-1">Cancelar</Btn>
          <Btn onClick={submit} disabled={saving} className="flex-1">
            {saving ? 'Guardando…' : 'Agregar modelo'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Provider create/edit modal ────────────────────────────────────────────────
function ProviderModal({ provider, onSave, onClose }) {
  const isEdit = !!provider
  const [form, setForm] = useState({
    slug:        provider?.slug         ?? '',
    displayName: provider?.display_name ?? '',
    baseUrl:     provider?.base_url     ?? '',
    apiType:     provider?.api_type     ?? 'openai-compatible',
    apiKeyEnv:   provider?.api_key_env  ?? '',
    apiKey:      '',   // never pre-filled for security
    isActive:    provider?.is_active    ?? false,
    notes:       provider?.notes        ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function submit() {
    if (!form.slug || !form.displayName || !form.baseUrl || !form.apiType)
      return setError('Slug, nombre, URL y tipo son requeridos')

    setSaving(true); setError('')
    try {
      const url    = isEdit ? `/api/providers/${provider.id}` : '/api/providers'
      const method = isEdit ? 'PATCH' : 'POST'
      const payload = {
        ...form,
        // Only send apiKey if it was filled in (empty = don't change on edit)
        apiKey: form.apiKey || (isEdit ? undefined : null),
      }

      const res  = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Error al guardar'); return }
      onSave(data)
    } catch { setError('Error de conexión') }
    finally { setSaving(false) }
  }

  return (
    <Modal title={isEdit ? `Editar — ${provider.display_name}` : 'Nuevo provider'} onClose={onClose} width="max-w-xl">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Slug *" hint="Identificador único, sin espacios">
            <Input placeholder="my-provider" value={form.slug}
              onChange={e => set('slug', e.target.value.toLowerCase().replace(/\s+/g, '-'))}
              disabled={isEdit} autoFocus={!isEdit} />
          </Field>
          <Field label="Nombre visible *">
            <Input placeholder="Mi Provider" value={form.displayName}
              onChange={e => set('displayName', e.target.value)} autoFocus={isEdit} />
          </Field>
        </div>

        <Field label="Base URL *" hint="Sin /v1 al final si es OpenAI-compatible">
          <Input placeholder="https://api.example.com" value={form.baseUrl}
            onChange={e => set('baseUrl', e.target.value)} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Tipo de API *">
            <Select value={form.apiType} onChange={e => set('apiType', e.target.value)}>
              {API_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          <Field label="Env var de API key" hint="Fallback si no se guarda la key aquí">
            <Input placeholder="MY_PROVIDER_API_KEY" value={form.apiKeyEnv}
              onChange={e => set('apiKeyEnv', e.target.value.toUpperCase())} />
          </Field>
        </div>

        {/* API key stored in DB — no rebuild needed */}
        <Field
          label={isEdit ? 'Nueva API key (dejar vacío para no cambiarla)' : 'API key'}
          hint="Se guarda en la DB. No se necesita rebuild al cambiarla."
        >
          <Input type="password" placeholder={isEdit && provider?.has_api_key ? '••••••• (ya guardada)' : 'sk-...'}
            value={form.apiKey} onChange={e => set('apiKey', e.target.value)} />
        </Field>

        <Field label="Notas">
          <Input placeholder="Descripción, modelos soportados, etc." value={form.notes}
            onChange={e => set('notes', e.target.value)} />
        </Field>

        <label className="flex items-center gap-2.5 cursor-pointer">
          <input type="checkbox" className="accent-accent"
            checked={form.isActive} onChange={e => set('isActive', e.target.checked)} />
          <div>
            <div className="text-sm font-medium text-default">Habilitado</div>
            <div className="text-xs text-muted">El proxy puede rutear requests a este provider</div>
          </div>
        </label>

        {error && <p className="text-xs text-err">{error}</p>}

        <div className="flex gap-3 pt-1">
          <Btn variant="secondary" onClick={onClose} className="flex-1">Cancelar</Btn>
          <Btn onClick={submit} disabled={saving} className="flex-1">
            {saving ? 'Guardando…' : isEdit ? 'Guardar cambios' : 'Crear provider'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Provider card ─────────────────────────────────────────────────────────────
function ProviderCard({ provider, onEdit, onToggle, onAddModel, onRemoveModel, toggling }) {
  return (
    <div className={`bg-card border border-border rounded-xl overflow-hidden shadow-card transition-opacity ${!provider.is_active ? 'opacity-60' : ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-strong">{provider.display_name}</span>
            {provider.is_active
              ? <span className="text-xs text-ok font-semibold">● Activo</span>
              : <span className="text-xs text-subtle">○ Inactivo</span>}
            {provider.has_api_key && (
              <span className="text-xs bg-accent-light text-accent-text border border-accent/20 rounded-full px-2 py-0.5">
                Key guardada
              </span>
            )}
          </div>
          <div className="text-xs text-muted mt-0.5 font-mono">{provider.base_url}</div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => onEdit(provider)}
            className="text-xs text-muted hover:text-default px-2 py-1 rounded hover:bg-raised transition-colors">
            Editar
          </button>
          <button
            onClick={() => onToggle(provider)}
            disabled={toggling === provider.id}
            className={`text-xs px-2.5 py-1 rounded-lg border font-medium transition-colors disabled:opacity-40 ${
              provider.is_active
                ? 'border-err/30 text-err hover:bg-err/5'
                : 'border-ok/30 text-ok hover:bg-ok/5'
            }`}>
            {toggling === provider.id ? '…' : provider.is_active ? 'Deshabilitar' : 'Habilitar'}
          </button>
        </div>
      </div>

      {/* Models */}
      <div className="px-5 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-muted uppercase tracking-wide">
            Modelos ({provider.models?.length ?? 0})
          </span>
          <button onClick={() => onAddModel(provider)}
            className="text-xs text-accent hover:text-accent-hover font-medium transition-colors">
            + Agregar modelo
          </button>
        </div>

        {!provider.models?.length ? (
          <p className="text-xs text-subtle py-2">
            Sin modelos — agregá al menos uno para que aparezca en las políticas.
          </p>
        ) : (
          <div className="space-y-1">
            {provider.models.map(m => (
              <div key={m.model_id} className="flex items-center justify-between group py-1">
                <div>
                  <span className="text-sm text-default">{m.display_name}</span>
                  <span className="text-xs text-subtle ml-2 font-mono">{m.model_id}</span>
                </div>
                <div className="flex items-center gap-3">
                  {(parseFloat(m.input_cost ?? m.cost_per_1k_input_tokens) > 0) && (
                    <span className="text-xs text-muted">
                      ${parseFloat(m.input_cost ?? m.cost_per_1k_input_tokens).toFixed(4)} / ${parseFloat(m.output_cost ?? m.cost_per_1k_output_tokens).toFixed(4)}
                    </span>
                  )}
                  {(parseFloat(m.input_cost ?? m.cost_per_1k_input_tokens) === 0) && (
                    <span className="text-xs text-ok">Local · $0</span>
                  )}
                  <button
                    onClick={() => onRemoveModel(provider, m.model_id)}
                    className="text-xs text-err opacity-0 group-hover:opacity-100 transition-opacity px-1">
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* API info */}
      <div className="px-5 py-2.5 bg-raised border-t border-border flex items-center gap-3 text-xs text-muted">
        <span className="font-mono bg-border rounded px-1.5 py-0.5">{provider.api_type}</span>
        {provider.api_key_env && <span>env: <code className="font-mono">{provider.api_key_env}</code></span>}
        {provider.notes && <span className="text-subtle truncate">{provider.notes}</span>}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ProvidersPage() {
  const [providers, setProviders] = useState([])
  const [loading,   setLoading]   = useState(true)
  const [modal,     setModal]     = useState(null)   // 'create' | { edit: p } | { addModel: p }
  const [toggling,  setToggling]  = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/providers')
    const data = await res.json()
    setProviders(Array.isArray(data) ? data : [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function toggleProvider(provider) {
    setToggling(provider.id)
    await fetch(`/api/providers/${provider.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !provider.is_active }),
    })
    setToggling(null)
    load()
  }

  async function removeModel(provider, modelId) {
    await fetch(`/api/providers/${provider.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ removeModelId: modelId }),
    })
    load()
  }

  const active   = providers.filter(p => p.is_active)
  const inactive = providers.filter(p => !p.is_active)

  return (
    <div className="p-7 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-xl font-bold text-strong">Providers</h1>
          <p className="text-sm text-muted mt-0.5">
            {active.length} activos · {inactive.length} inactivos
          </p>
        </div>
        <Btn onClick={() => setModal('create')}>+ Nuevo provider</Btn>
      </div>

      {/* Info banner */}
      <div className="bg-accent-light border border-accent/20 rounded-xl px-4 py-3 mb-6 text-xs text-accent-text">
        💡 Las API keys guardadas aquí no requieren rebuild. El proxy las toma automáticamente en hasta 60 segundos.
        Los modelos agregados aparecen de inmediato en el selector de políticas.
      </div>

      {loading ? (
        <div className="text-center py-20 text-muted text-sm">Cargando…</div>
      ) : (
        <div className="space-y-4">
          {providers.length === 0 ? (
            <div className="text-center py-20 text-subtle text-sm">
              No hay providers configurados todavía.
            </div>
          ) : (
            providers.map(p => (
              <ProviderCard
                key={p.id}
                provider={p}
                toggling={toggling}
                onEdit={p => setModal({ edit: p })}
                onToggle={toggleProvider}
                onAddModel={p => setModal({ addModel: p })}
                onRemoveModel={removeModel}
              />
            ))
          )}
        </div>
      )}

      {/* Modals */}
      {modal === 'create'   && <ProviderModal onSave={() => { setModal(null); load() }} onClose={() => setModal(null)} />}
      {modal?.edit          && <ProviderModal provider={modal.edit} onSave={() => { setModal(null); load() }} onClose={() => setModal(null)} />}
      {modal?.addModel      && <AddModelModal provider={modal.addModel} onSave={() => { setModal(null); load() }} onClose={() => setModal(null)} />}
    </div>
  )
}
