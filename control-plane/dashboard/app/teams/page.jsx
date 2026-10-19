'use client'

import { useState, useEffect, useCallback } from 'react'
import Modal, { Field, Input, Select, Btn } from '../../components/Modal'
import { usePermissions } from '../../components/usePermissions'
import { formatCost, formatCostCompact, formatTokens, nf } from '../../lib/format'

// A new team (team === null) or an existing one. Team managers only see the
// budget: the name and the policy need 'teams.manage'.
function TeamModal({ team, policies, canManage, onSave, onClose }) {
  const isNew = !team
  const [form, setForm] = useState({
    name:             team?.name        ?? '',
    department:       team?.department  ?? '',
    policyId:         team?.policy_id   ?? '',
    monthlyBudgetUsd: team?.team_budget ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const budget = form.monthlyBudgetUsd === '' || form.monthlyBudgetUsd == null ? null : Number(form.monthlyBudgetUsd)

  async function submit() {
    if (canManage && !form.name.trim()) { setError('El equipo necesita un nombre.'); return }
    setSaving(true); setError('')
    const body = canManage
      ? { name: form.name, policyId: form.policyId || null, monthlyBudgetUsd: budget,
          ...(isNew ? { department: form.department } : {}) }
      : { monthlyBudgetUsd: budget }
    try {
      const res = await fetch(isNew ? '/api/teams' : `/api/teams/${team.id}`, {
        method: isNew ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.message ?? data.error ?? 'No se pudo guardar.'); return }
      onSave()
    } catch { setError('No se pudo conectar con la consola.') }
    finally { setSaving(false) }
  }

  return (
    <Modal title={isNew ? 'Nuevo equipo' : `Editar · ${team.name}`} onClose={onClose}>
      <div className="space-y-4">
        {canManage && (
          <>
            <Field label="Nombre">
              <Input value={form.name} placeholder="Ej.: Producto" onChange={e => set('name', e.target.value)} />
            </Field>
            {isNew && (
              <Field label="Área" hint="Opcional. Sirve para agrupar equipos en los reportes.">
                <Input value={form.department} placeholder="Ej.: Tecnología" onChange={e => set('department', e.target.value)} />
              </Field>
            )}
            <Field label="Política" hint="Qué modelos y proveedores puede usar el equipo, y con qué cuota de tokens.">
              <Select value={form.policyId} onChange={e => set('policyId', e.target.value)}>
                <option value="">Sin política: el gateway rechaza sus pedidos</option>
                {policies.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
          </>
        )}
        <Field
          label="Presupuesto mensual del equipo (US$)"
          hint="Vacío: se toma el de la política. Es una referencia para seguir el gasto; el gateway corta por la cuota de tokens."
        >
          <Input
            type="number" min="0" step="1" inputMode="decimal" placeholder="Ej.: 500"
            value={form.monthlyBudgetUsd ?? ''}
            onChange={e => set('monthlyBudgetUsd', e.target.value)}
          />
        </Field>

        {error && <p role="alert" className="text-sm text-err">{error}</p>}
        <div className="flex gap-2 pt-1">
          <Btn variant="secondary" onClick={onClose} className="flex-1">Cancelar</Btn>
          <Btn onClick={submit} disabled={saving} className="flex-1">
            {saving ? 'Guardando…' : isNew ? 'Crear equipo' : 'Guardar cambios'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

function Metric({ label, children }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted mb-1">{label}</div>
      <div className="text-lg font-semibold text-strong tabular">{children}</div>
    </div>
  )
}

// Spent against a limit. `tone` turns amber from 80 % and red from 100 %.
function Meter({ label, used, limit, format, formatLimit = format, note }) {
  const pct = limit > 0 ? (used / limit) * 100 : 0
  const tone = pct >= 100 ? 'bg-err' : pct >= 80 ? 'bg-warn' : 'bg-accent'
  const text = pct >= 100 ? 'text-err' : pct >= 80 ? 'text-warn' : 'text-muted'
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span className="text-default">{label}</span>
        <span className={`tabular ${text}`}>
          {format(used)} de {formatLimit(limit)} · {nf(pct)} %
        </span>
      </div>
      <div className="h-1.5 bg-raised rounded-full overflow-hidden" role="meter" aria-label={label}
           aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(pct, 100))}>
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      {note && <div className="text-xs text-muted">{note}</div>}
    </div>
  )
}

export default function TeamsPage() {
  const { can } = usePermissions()
  const canManage = can('teams.manage')
  const canBudget = can('teams.budget')
  const [teams,    setTeams]    = useState([])
  const [policies, setPolicies] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [modal,    setModal]    = useState(null)   // { team } — team null for a new one
  const [notice,   setNotice]   = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const [t, p] = await Promise.all([
      fetch('/api/teams-detail').then(r => (r.ok ? r.json() : [])),
      fetch('/api/policies').then(r => (r.ok ? r.json() : [])),
    ])
    setTeams(Array.isArray(t) ? t : []); setPolicies(Array.isArray(p) ? p : []); setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function remove(team) {
    setNotice('')
    if (!window.confirm(`¿Eliminar el equipo ${team.name}? Sus alertas se borran; el historial de consumo queda.`)) return
    const res = await fetch(`/api/teams/${team.id}`, { method: 'DELETE' })
    if (!res.ok) setNotice((await res.json().catch(() => ({}))).message ?? 'No se pudo eliminar el equipo.')
    load()
  }

  const action = 'min-h-[36px] px-2.5 rounded-md text-[13px] text-accent hover:bg-accent-light whitespace-nowrap disabled:opacity-40'

  return (
    <div className="px-4 py-6 md:px-10 md:py-8 max-w-screen-xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-[26px] font-semibold text-strong tracking-tight">Equipos</h1>
          <p className="text-sm text-muted">
            Cada persona y cada agente pertenece a un equipo. La política del equipo decide qué modelos usa y cuántos tokens por mes.
          </p>
        </div>
        {canManage && <Btn onClick={() => setModal({ team: null })}>+ Nuevo equipo</Btn>}
      </div>

      {notice && (
        <div role="alert" className="bg-err-light border border-err/20 rounded-md px-4 py-3 text-sm text-err">{notice}</div>
      )}

      {loading && <p className="text-sm text-muted">Cargando…</p>}

      {!loading && teams.length === 0 && (
        <div className="bg-card border border-border rounded-[10px] px-8 py-14 text-center space-y-1">
          <div className="text-sm font-medium text-strong">Todavía no hay equipos</div>
          <div className="text-sm text-muted">
            {canManage
              ? 'Creá el primero y asignale una política; después sumá personas y agentes.'
              : 'Una persona con rol de administración tiene que crearlos.'}
          </div>
        </div>
      )}

      {!loading && teams.length > 0 && (
        <div className="space-y-3">
          {teams.map(team => {
            const spent  = Number(team.cost_month ?? 0)
            const tokens = Number(team.tokens_month ?? 0)
            const own    = team.team_budget != null
            const budget = Number(team.team_budget ?? team.policy_budget ?? 0)
            const quota  = Number(team.monthly_token_quota ?? 0)
            const models = team.allow_all_models ? null : (team.allowed_models ?? [])
            const empty  = Number(team.members ?? 0) === 0 && Number(team.agents ?? 0) === 0

            return (
              <div key={team.id} data-testid="team-row" className="bg-card border border-border rounded-[10px]">
                <div className="px-5 py-4 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-strong">{team.name}</div>
                      {team.department && <div className="text-xs text-muted mt-0.5">{team.department}</div>}
                    </div>
                    {team.policy_name
                      ? <span className="text-xs text-default border border-border rounded px-2 py-0.5">{team.policy_name}</span>
                      : <span className="text-xs text-warn border border-warn/30 rounded px-2 py-0.5">Sin política: el gateway rechaza sus pedidos</span>}
                  </div>
                  {(canManage || canBudget) && (
                    <div className="flex flex-wrap items-center gap-1">
                      <button type="button" onClick={() => setModal({ team })} className={action}>
                        {canManage ? 'Editar' : 'Presupuesto'}
                      </button>
                      {canManage && (
                        <button
                          type="button" onClick={() => remove(team)}
                          disabled={!empty}
                          title={empty ? undefined : 'Mové sus personas y agentes a otro equipo primero'}
                          className={`${action} !text-err hover:!bg-err-light`}
                        >
                          Eliminar
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="px-5 py-4 border-t border-border grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <Metric label="Requests del mes">{nf(team.requests_month)}</Metric>
                  <Metric label="Tokens">{formatTokens(tokens)}</Metric>
                  <Metric label="Costo estimado">{formatCost(spent)}</Metric>
                  <Metric label="Personas · agentes">
                    {nf(team.total_users)} · {nf(team.agents)}
                  </Metric>
                </div>

                {(quota > 0 || budget > 0) && (
                  <div className="px-5 py-4 border-t border-border grid gap-4 md:grid-cols-2">
                    {quota > 0 && (
                      <Meter label="Cuota de tokens" used={tokens} limit={quota} format={formatTokens}
                             note="La aplica el gateway: al llegar al 100 % rechaza los pedidos hasta el mes siguiente." />
                    )}
                    {budget > 0 && (
                      <Meter label={own ? 'Presupuesto del equipo' : 'Presupuesto de la política'} used={spent} limit={budget}
                             format={formatCost} formatLimit={formatCostCompact} note="Referencia para seguir el gasto; no corta pedidos." />
                    )}
                  </div>
                )}

                <div className="px-5 py-3 border-t border-border flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-muted mr-1">Modelos</span>
                  {!team.policy_name
                    ? <span className="text-muted">ninguno</span>
                    : models === null
                      ? <span className="text-default">todos los del catálogo</span>
                      : models.length === 0
                        ? <span className="text-warn">ninguno permitido</span>
                        : models.map(m => (
                            <span key={m} className="font-mono text-default border border-border rounded px-2 py-0.5">{m}</span>
                          ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {modal && (
        <TeamModal
          team={modal.team}
          policies={policies}
          canManage={canManage}
          onSave={() => { setModal(null); load() }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}
