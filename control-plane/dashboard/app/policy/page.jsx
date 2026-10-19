'use client'

import { useState, useEffect, useCallback } from 'react'
import Modal, { Field, Input, Select, Btn } from '../../components/Modal'
import { formatCost, formatCostCompact, formatTokens, nf } from '../../lib/format'
import { namesOf } from '../../lib/catalog'
import { usePermissions } from '../../components/usePermissions'


// ─── Policy form modal ────────────────────────────────────────────────────────
function PolicyModal({ policy, allModels, configured, onSave, onClose }) {
  const isEdit = !!policy
  const [form, setForm] = useState({
    name:                policy?.name                    ?? '',
    allowAllModels:      policy?.allow_all_models        ?? false,
    allowedModels:       policy?.allowed_models          ?? [],
    allowedProviders:    policy?.allowed_providers?.length ? policy.allowed_providers : null,
    maxTokensPerRequest: policy?.max_tokens_per_request  ?? 4096,
    monthlyTokenQuota:   policy?.monthly_token_quota     ?? 1000000,
    monthlyBudgetUsd:    policy?.monthly_budget_usd      ?? 100,
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  // A model counts as chosen when the list names any of its IDs (an alias,
  // or "provider/id"), as gateways read it; unchecking removes every one.
  const isChosen = m => namesOf(m).some(n => form.allowedModels.includes(n))
  function toggleModel(m) {
    setForm(f => {
      const names = new Set(namesOf(m))
      return {
        ...f,
        allowedModels: f.allowedModels.some(n => names.has(n))
          ? f.allowedModels.filter(n => !names.has(n))
          : [...f.allowedModels, m.model_id],
      }
    })
  }
  const outside = form.allowedModels.filter(n => !allModels.some(m => namesOf(m).includes(n)))

  function toggleProvider(id) {
    setForm(f => {
      const cur = f.allowedProviders ?? []
      return { ...f, allowedProviders: cur.includes(id) ? cur.filter(p => p !== id) : [...cur, id] }
    })
  }

  async function submit() {
    if (!form.name.trim()) { setError('El nombre es requerido'); return }
    if (!form.allowAllModels && form.allowedModels.length === 0) {
      setError('Elegí al menos un modelo, o permití todos.'); return
    }
    if (form.allowedProviders && form.allowedProviders.length === 0) {
      setError('Elegí al menos un proveedor, o permití todos.'); return
    }
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
      if (!res.ok) { setError(data.message ?? data.error ?? 'Error al guardar'); return }
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

        {/* Providers */}
        <Field label="Proveedores" hint="Los que este equipo puede usar, entre los configurados en la organización.">
          <div className="space-y-2 mt-1">
            <label className="flex items-center gap-2 text-sm text-strong">
              <input type="radio" name="providers" checked={form.allowedProviders === null}
                onChange={() => set('allowedProviders', null)} className="accent-[#2448b8]" />
              Todos los configurados
            </label>
            <label className="flex items-center gap-2 text-sm text-strong">
              <input type="radio" name="providers" checked={form.allowedProviders !== null}
                onChange={() => set('allowedProviders', form.allowedProviders ?? [])} className="accent-[#2448b8]" />
              Solo estos
            </label>
            {form.allowedProviders !== null && (
              <div className="flex flex-wrap gap-2 pl-6">
                {[...configured, ...form.allowedProviders.filter(id => !configured.some(c => c.id === id))
                  .map(id => ({ id, label: `${id} (sin configurar)` }))].map(p => (
                  <label key={p.id} className="flex items-center gap-1.5 text-xs text-default border border-border rounded-md px-2 py-1">
                    <input type="checkbox" checked={form.allowedProviders.includes(p.id)}
                      onChange={() => toggleProvider(p.id)} className="accent-[#2448b8]" />
                    {p.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </Field>

        {/* Models */}
        <Field label="Modelos">
          <div className="space-y-2 mt-1">
            <label className="flex items-center gap-2 text-sm text-strong">
              <input type="radio" name="models" checked={form.allowAllModels}
                onChange={() => set('allowAllModels', true)} className="accent-[#2448b8]" />
              Todos los modelos de esos proveedores
            </label>
            <label className="flex items-center gap-2 text-sm text-strong">
              <input type="radio" name="models" checked={!form.allowAllModels}
                onChange={() => set('allowAllModels', false)} className="accent-[#2448b8]" />
              Solo los elegidos
            </label>
          </div>
          {!form.allowAllModels && (
          <div className="space-y-3 mt-3">
            {Object.entries(grouped).map(([provider, models]) => (
              <div key={provider}>
                <div className="text-xs text-muted uppercase tracking-wide mb-1.5">{provider}</div>
                <div className="space-y-1">
                  {models.map(m => {
                    const checked = isChosen(m)
                    return (
                      <label
                        key={m.model_id}
                        className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg cursor-pointer border transition-colors
                          ${checked
                            ? 'bg-accent/10 border-accent/40'
                            : 'bg-card border-border hover:border-border-strong'}`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleModel(m)}
                            className="accent-[#2448b8]"
                          />
                          <span className="text-sm text-strong">{m.display_name}</span>
                          <span className="font-mono text-xs text-muted truncate"
                            title={(m.aliases ?? []).length ? `También: ${m.aliases.join(', ')}` : undefined}>
                            {m.model_id}{(m.aliases ?? []).length ? ` (+${m.aliases.length} alias)` : ''}
                          </span>
                        </div>
                        <div className="text-xs text-subtle tabular-nums">
                          {formatCost(parseFloat(m.cost_per_1k_output_tokens) * 1000)}/1M salida
                        </div>
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
            {outside.length > 0 && (
              <p className="text-xs text-muted">
                También permitidos, fuera del catálogo: {outside.join(', ')}
              </p>
            )}
          </div>
          )}
        </Field>

        {/* Limits */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Máx. tokens por pedido" hint="Todavía no lo aplica el gateway.">
            <Input
              type="number"
              value={form.maxTokensPerRequest}
              onChange={e => set('maxTokensPerRequest', parseInt(e.target.value))}
            />
          </Field>
          <Field label="Cuota mensual (tokens)" hint="La aplica el gateway, por equipo.">
            <Input
              type="number"
              value={form.monthlyTokenQuota}
              onChange={e => set('monthlyTokenQuota', parseInt(e.target.value))}
            />
          </Field>
          <Field label="Presupuesto mensual (US$)" hint="Referencia para seguir el gasto; no corta pedidos.">
            <Input
              type="number"
              step="0.01"
              value={form.monthlyBudgetUsd}
              onChange={e => set('monthlyBudgetUsd', parseFloat(e.target.value))}
            />
          </Field>
        </div>

        {error && <p className="text-xs text-err">{error}</p>}

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
    if (!res.ok) { setError(data.message ?? data.error); setDeleting(false); return }
    onConfirm()
  }

  return (
    <Modal title="Eliminar política" onClose={onClose} width="max-w-sm">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          ¿Eliminás <strong className="text-strong">"{policy.name}"</strong>?
          Esta acción no se puede deshacer.
        </p>
        {error && <p className="text-xs text-err">{error}</p>}
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
  const { can } = usePermissions()
  const canManage = can('policies.manage')
  const [policies,  setPolicies]  = useState([])
  const [allModels, setAllModels] = useState([])
  const [configured, setConfigured] = useState([])
  const [loading,   setLoading]   = useState(true)
  const [modal,     setModal]     = useState(null) // null | 'create' | { edit: p } | { delete: p }

  const load = useCallback(async () => {
    setLoading(true)
    const [p, m, prov] = await Promise.all([
      fetch('/api/policies').then(r => r.json()),
      fetch('/api/models').then(r => r.json()),
      // Roles without providers.read (team managers) get 403: the form then lists none.
      fetch('/api/internal/providers').then(r => (r.ok ? r.json() : null)).catch(() => null),
    ])
    setPolicies(p)
    setAllModels(m)
    const names = new Map((prov?.providers ?? []).map(c => [c.provider, c.provider_label ?? c.provider]))
    setConfigured([...names].map(([id, label]) => ({ id, label })))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  function handleSave() { setModal(null); load() }

  return (
    <div className="px-4 py-6 md:px-10 md:py-8 max-w-screen-xl space-y-5">

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-semibold text-strong tracking-tight">Políticas</h1>
          <p className="text-sm text-muted mt-0.5">
            Qué modelos y proveedores puede usar cada equipo, y cuántos tokens por mes.
          </p>
        </div>
        {canManage && <Btn onClick={() => setModal('create')}>+ Nueva política</Btn>}
      </div>

      {loading ? (
        <div className="text-center text-muted text-sm py-10">Cargando…</div>
      ) : (
        policies.map(policy => {
          const budget = parseFloat(policy.monthly_budget_usd ?? 0)
          return (
            <div key={policy.id} className="bg-card border border-border rounded-[10px] overflow-hidden">

              {/* Header */}
              <div className="px-5 py-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className="font-semibold text-strong">{policy.name}</span>
                  <span className="ml-3 text-xs text-muted">
                    {policy.teams_using} equipo{policy.teams_using != 1 ? 's' : ''} asignado{policy.teams_using != 1 ? 's' : ''}
                  </span>
                </div>
                {canManage && <div className="flex gap-2">
                  <button
                    onClick={() => setModal({ edit: policy })}
                    className="text-xs text-muted hover:text-strong px-3 py-1.5 rounded-lg border border-border hover:bg-raised transition-colors"
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => setModal({ delete: policy })}
                    className="text-xs text-err hover:text-err px-3 py-1.5 rounded-lg border border-err/30 hover:bg-err-light transition-colors"
                  >
                    Eliminar
                  </button>
                </div>}
              </div>

              {/* Stats */}
              <div className="p-5 grid grid-cols-1 sm:grid-cols-3 gap-5">
                <div>
                  <div className="text-xs text-muted mb-1">Cuota de tokens por mes</div>
                  <div className="text-lg font-semibold text-strong tabular">
                    {policy.monthly_token_quota ? formatTokens(policy.monthly_token_quota) : 'Sin límite'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted mb-1">Presupuesto mensual</div>
                  <div className="text-lg font-semibold text-strong tabular">{budget > 0 ? formatCostCompact(budget) : '—'}</div>
                </div>
                <div>
                  <div className="text-xs text-muted mb-1">Máx. tokens por pedido</div>
                  <div className="text-lg font-semibold text-strong tabular">
                    {policy.max_tokens_per_request ? nf(policy.max_tokens_per_request) : '—'}
                  </div>
                </div>
              </div>

              {/* Providers and models */}
              <div className="px-5 pb-5 space-y-3">
                <div>
                  <div className="text-xs text-muted mb-2">Proveedores</div>
                  {(policy.allowed_providers ?? []).length === 0 ? (
                    <span className="text-xs text-muted">Todos los configurados</span>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {policy.allowed_providers.map(p => (
                        <span key={p} className="text-xs border border-border rounded px-2 py-0.5 font-mono text-default">{p}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <div className="text-xs text-muted mb-2">Modelos</div>
                  {policy.allow_all_models ? (
                    <span className="text-xs text-muted">Todos</span>
                  ) : (policy.allowed_models ?? []).length === 0 ? (
                    <span className="text-xs text-err">Ninguno: el gateway rechaza todos los pedidos de este equipo</span>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {policy.allowed_models.map(model => (
                        <span key={model} className="text-xs border border-border rounded px-2 py-0.5 font-mono text-default">
                          {model}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })
      )}

      {/* Modals */}
      {modal === 'create' && (
        <PolicyModal allModels={allModels} configured={configured} onSave={handleSave} onClose={() => setModal(null)} />
      )}
      {modal?.edit && (
        <PolicyModal policy={modal.edit} allModels={allModels} configured={configured} onSave={handleSave} onClose={() => setModal(null)} />
      )}
      {modal?.delete && (
        <DeleteConfirm policy={modal.delete} onConfirm={handleSave} onClose={() => setModal(null)} />
      )}
    </div>
  )
}
