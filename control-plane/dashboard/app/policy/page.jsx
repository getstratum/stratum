'use client'

import { useState, useEffect, useCallback } from 'react'
import Modal, { Field, Input, Select, Btn } from '../../components/Modal'
import { formatCost } from '../../lib/format'

const PROVIDER_COLORS = {
  openai:    'bg-emerald-950/50 text-emerald-300 border-emerald-800/50',
  anthropic: 'bg-orange-950/50 text-orange-300 border-orange-800/50',
}

// ─── Policy form modal ────────────────────────────────────────────────────────
function PolicyModal({ policy, allModels, onSave, onClose }) {
  const isEdit = !!policy
  const [form, setForm] = useState({
    name:                policy?.name                    ?? '',
    allowedModels:       policy?.allowed_models          ?? [],
    maxTokensPerRequest: policy?.max_tokens_per_request  ?? 4096,
    monthlyTokenQuota:   policy?.monthly_token_quota     ?? 1000000,
    monthlyBudgetUsd:    policy?.monthly_budget_usd      ?? 100,
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  function toggleModel(modelId) {
    setForm(f => ({
      ...f,
      allowedModels: f.allowedModels.includes(modelId)
        ? f.allowedModels.filter(m => m !== modelId)
        : [...f.allowedModels, modelId],
    }))
  }

  async function submit() {
    if (!form.name.trim()) { setError('El nombre es requerido'); return }
    setSaving(true)
    setError('')
    try {
      const url    = isEdit ? `/api/policies/${policy.id}` : '/api/policies'
      const method = isEdit ? 'PATCH' : 'POST'
      const res    = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Error al guardar'); return }
      onSave(data)
    } catch { setError('Error de conexión') }
    finally { setSaving(false) }
  }

  // Group models by provider
  const grouped = allModels.reduce((acc, m) => {
    acc[m.provider] = acc[m.provider] ?? []
    acc[m.provider].push(m)
    return acc
  }, {})

  return (
    <Modal title={isEdit ? 'Editar política' : 'Nueva política'} onClose={onClose} width="max-w-xl">
      <div className="space-y-5">
        <Field label="Nombre *">
          <Input
            placeholder="Ej: Engineering Policy"
            value={form.name}
            onChange={e => set('name', e.target.value)}
            autoFocus
          />
        </Field>

        {/* Model selector */}
        <Field
          label="Modelos permitidos"
          hint="Sin selección = todos los modelos disponibles"
        >
          <div className="space-y-3 mt-1">
            {Object.entries(grouped).map(([provider, models]) => (
              <div key={provider}>
                <div className="text-xs text-slate-500 uppercase tracking-wide mb-1.5">{provider}</div>
                <div className="space-y-1">
                  {models.map(m => {
                    const checked = form.allowedModels.includes(m.model_id)
                    return (
                      <label
                        key={m.model_id}
                        className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg cursor-pointer border transition-colors
                          ${checked
                            ? 'bg-accent/10 border-accent/40'
                            : 'bg-surface border-border hover:border-slate-600'}`}
                      >
                        <div className="flex items-center gap-2.5">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleModel(m.model_id)}
                            className="accent-blue-500"
                          />
                          <span className="text-sm text-slate-200">{m.display_name}</span>
                          <span className="font-mono text-xs text-slate-500">{m.model_id}</span>
                        </div>
                        <div className="text-xs text-slate-600 tabular-nums">
                          {formatCost(parseFloat(m.cost_per_1k_output_tokens) * 1000)}/1K
                        </div>
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </Field>

        {/* Limits */}
        <div className="grid grid-cols-3 gap-3">
          <Field label="Max tokens/req">
            <Input
              type="number"
              value={form.maxTokensPerRequest}
              onChange={e => set('maxTokensPerRequest', parseInt(e.target.value))}
            />
          </Field>
          <Field label="Quota mensual (tokens)">
            <Input
              type="number"
              value={form.monthlyTokenQuota}
              onChange={e => set('monthlyTokenQuota', parseInt(e.target.value))}
            />
          </Field>
          <Field label="Budget mensual (USD)">
            <Input
              type="number"
              step="0.01"
              value={form.monthlyBudgetUsd}
              onChange={e => set('monthlyBudgetUsd', parseFloat(e.target.value))}
            />
          </Field>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex gap-3 pt-1">
          <Btn variant="secondary" onClick={onClose} className="flex-1">Cancelar</Btn>
          <Btn onClick={submit} disabled={saving} className="flex-1">
            {saving ? 'Guardando…' : isEdit ? 'Guardar cambios' : 'Crear política'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

// ─── Delete confirm ───────────────────────────────────────────────────────────
function DeleteConfirm({ policy, onConfirm, onClose }) {
  const [deleting, setDeleting] = useState(false)
  const [error,    setError]    = useState('')

  async function confirm() {
    setDeleting(true)
    const res  = await fetch(`/api/policies/${policy.id}`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) { setError(data.error); setDeleting(false); return }
    onConfirm()
  }

  return (
    <Modal title="Eliminar política" onClose={onClose} width="max-w-sm">
      <div className="space-y-4">
        <p className="text-sm text-slate-400">
          ¿Eliminás <strong className="text-white">"{policy.name}"</strong>?
          Esta acción no se puede deshacer.
        </p>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-3">
          <Btn variant="secondary" onClick={onClose} className="flex-1">Cancelar</Btn>
          <Btn variant="danger" onClick={confirm} disabled={deleting} className="flex-1">
            {deleting ? 'Eliminando…' : 'Eliminar'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function PolicyPage() {
  const [policies,  setPolicies]  = useState([])
  const [allModels, setAllModels] = useState([])
  const [loading,   setLoading]   = useState(true)
  const [modal,     setModal]     = useState(null) // null | 'create' | { edit: p } | { delete: p }

  const load = useCallback(async () => {
    setLoading(true)
    const [p, m] = await Promise.all([
      fetch('/api/policies').then(r => r.json()),
      fetch('/api/models').then(r => r.json()),
    ])
    setPolicies(p)
    setAllModels(m)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function handleSave() { setModal(null); load() }

  return (
    <div className="p-7 max-w-4xl space-y-5">

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Políticas de Acceso</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Define qué modelos puede usar cada equipo y con qué límites
          </p>
        </div>
        <Btn onClick={() => setModal('create')}>+ Nueva política</Btn>
      </div>

      {loading ? (
        <div className="text-center text-slate-500 text-sm py-10">Cargando…</div>
      ) : (
        policies.map(policy => {
          const budget = parseFloat(policy.monthly_budget_usd ?? 0)
          return (
            <div key={policy.id} className="bg-surface-card border border-border rounded-xl overflow-hidden">

              {/* Header */}
              <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                <div>
                  <span className="font-bold text-white">{policy.name}</span>
                  <span className="ml-3 text-xs text-slate-500">
                    {policy.teams_using} equipo{policy.teams_using != 1 ? 's' : ''} asignado{policy.teams_using != 1 ? 's' : ''}
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setModal({ edit: policy })}
                    className="text-xs text-slate-400 hover:text-slate-200 px-3 py-1.5 rounded-lg border border-border hover:bg-surface transition-colors"
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => setModal({ delete: policy })}
                    className="text-xs text-red-400 hover:text-red-300 px-3 py-1.5 rounded-lg border border-red-900/50 hover:bg-red-950/30 transition-colors"
                  >
                    Eliminar
                  </button>
                </div>
              </div>

              {/* Stats */}
              <div className="p-5 grid grid-cols-3 gap-5">
                <div>
                  <div className="text-xs text-slate-500 mb-1">Budget mensual</div>
                  <div className="text-xl font-bold text-orange-300">${budget.toFixed(0)} USD</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">Quota de tokens</div>
                  <div className="text-xl font-bold text-purple-300">
                    {(policy.monthly_token_quota / 1_000_000).toFixed(1)}M / mes
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">Max tokens / req</div>
                  <div className="text-xl font-bold text-blue-300">
                    {Number(policy.max_tokens_per_request).toLocaleString()}
                  </div>
                </div>
              </div>

              {/* Models */}
              <div className="px-5 pb-5">
                <div className="text-xs text-slate-500 mb-2">Modelos permitidos</div>
                <div className="flex flex-wrap gap-2">
                  {(policy.allowed_models ?? []).length === 0 ? (
                    <span className="text-xs text-slate-600">Todos los modelos</span>
                  ) : (
                    policy.allowed_models.map(model => {
                      const provider = model.startsWith('gpt') || model.startsWith('o') ? 'openai' : 'anthropic'
                      return (
                        <span
                          key={model}
                          className={`text-xs border rounded-lg px-3 py-1.5 font-mono ${PROVIDER_COLORS[provider] ?? 'bg-slate-800 text-slate-300 border-slate-700'}`}
                        >
                          {model}
                        </span>
                      )
                    })
                  )}
                </div>
              </div>
            </div>
          )
        })
      )}

      {/* Modals */}
      {modal === 'create' && (
        <PolicyModal allModels={allModels} onSave={handleSave} onClose={() => setModal(null)} />
      )}
      {modal?.edit && (
        <PolicyModal policy={modal.edit} allModels={allModels} onSave={handleSave} onClose={() => setModal(null)} />
      )}
      {modal?.delete && (
        <DeleteConfirm policy={modal.delete} onConfirm={handleSave} onClose={() => setModal(null)} />
      )}
    </div>
  )
}
