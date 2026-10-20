'use client'

import Link from 'next/link'
import { useState, useEffect, useCallback } from 'react'
import Modal, { Field, Input, Select, Btn } from '../../components/Modal'
import { usePermissions } from '../../components/usePermissions'
import { formatCost, formatTokens } from '../../lib/format'
import { allowedBy } from '../../lib/catalog'

// ─── One-time key reveal ──────────────────────────────────────────────────────
function KeyReveal({ apiKey, onClose }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(apiKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* the key stays selectable */ }
  }
  return (
    <Modal title="Key del agente generada" onClose={onClose} width="max-w-md">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Es la única vez que se muestra. Copiala ahora y guardala en un lugar seguro.
        </p>
        <div className="flex gap-2">
          <code data-testid="revealed-key" className="flex-1 bg-app border border-border rounded-md px-3 py-2 text-xs text-strong font-mono break-all select-all">
            {apiKey}
          </code>
          <button
            type="button"
            onClick={copy}
            className="flex-shrink-0 min-h-[40px] bg-card border border-border-strong rounded-md px-3 text-xs text-strong"
          >
            {copied ? 'Copiada' : 'Copiar'}
          </button>
        </div>
        <div className="bg-raised border border-border rounded-md p-3 text-xs text-muted space-y-1">
          <div>En la configuración del agente:</div>
          <code className="text-default font-mono">Authorization: Bearer {apiKey.slice(0, 20)}…</code>
        </div>
        <Btn variant="secondary" onClick={onClose} className="w-full">
          Ya la guardé, cerrar
        </Btn>
      </div>
    </Modal>
  )
}

// ─── Create / Edit modal ──────────────────────────────────────────────────────
function AgentModal({ agent, teams, models, canDelegate, onSave, onClose }) {
  const isEdit = !!agent
  const [form, setForm] = useState({
    name:            agent?.name             ?? '',
    description:     agent?.description      ?? '',
    teamId:          agent?.team_id          ?? '',
    defaultModel:    agent?.default_model    ?? '',
    defaultProvider: agent?.default_provider ?? '',
    delegates:       agent?.delegates        ?? false,
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function submit() {
    if (!form.name.trim()) { setError('El nombre es obligatorio.'); return }
    if (!form.teamId) { setError('Elegí un equipo: el agente trabaja bajo su política.'); return }
    setSaving(true); setError('')
    try {
      const res  = await fetch(
        isEdit ? `/api/agents/${agent.id}` : '/api/agents',
        {
          method:  isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
              ...form,
              defaultModel:    form.defaultModel    || null,
              defaultProvider: form.defaultProvider || null,
            }),
        }
      )
      const data = await res.json()
      if (!res.ok) { setError(data.message ?? data.error ?? 'No se pudo guardar.'); return }
      onSave(data)
    } catch { setError('No se pudo conectar con la consola.') }
    finally { setSaving(false) }
  }

  // Only the models the selected team's policy allows.
  const selectedTeam    = teams.find(t => t.id === form.teamId)
  const availableModels = selectedTeam ? models.filter(m => allowedBy(selectedTeam, m)) : []
  const value = form.defaultModel ? `${form.defaultProvider}/${form.defaultModel}` : ''

  return (
    <Modal title={isEdit ? 'Editar agente' : 'Nuevo agente'} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Nombre *">
          <Input
            placeholder="Ej.: bot de soporte"
            value={form.name}
            onChange={e => set('name', e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Descripción" hint="Qué hace este agente.">
          <Input
            placeholder="Responde tickets de soporte de primer nivel"
            value={form.description}
            onChange={e => set('description', e.target.value)}
          />
        </Field>
        <Field label="Equipo" hint="El agente usa la política del equipo.">
          <Select
            value={form.teamId}
            onChange={e => {
              // The new team's policy may allow other models.
              set('teamId', e.target.value)
              set('defaultModel', '')
              set('defaultProvider', '')
            }}
          >
            <option value="" disabled>Elegí un equipo</option>
            {teams.map(t => (
              <option key={t.id} value={t.id}>
                {t.name} {t.policy_name ? `· ${t.policy_name}` : ''}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Modelo fijo"
          hint="Los gateways mandan todos los pedidos del agente a este modelo, pida el que pida: cambiándolo acá cambia para todas sus llamadas. Tiene que estar permitido por la política del equipo. Vacío: el agente elige."
        >
          <Select
            value={value}
            disabled={!form.teamId}
            onChange={e => {
              const [provider, ...rest] = e.target.value.split('/')
              set('defaultProvider', e.target.value ? provider : '')
              set('defaultModel',    e.target.value ? rest.join('/') : '')
            }}
          >
            <option value="">
              {!form.teamId ? 'Primero elegí un equipo' : 'Ninguno: el agente elige'}
            </option>
            {availableModels.map(m => (
              <option key={`${m.provider}/${m.model_id}`} value={`${m.provider}/${m.model_id}`}>
                {m.display_name} · {m.provider}
              </option>
            ))}
            {value && !availableModels.some(m => `${m.provider}/${m.model_id}` === value) && (
              <option value={value}>{value} (fuera de la política)</option>
            )}
          </Select>
        </Field>
        {form.teamId && availableModels.length === 0 && (
          <p className="text-xs text-warn">La política de este equipo no permite ningún modelo del catálogo.</p>
        )}
        {form.defaultModel && (
          <p className="text-xs text-muted">
            El agente puede llamar a <code className="text-default font-mono">/v1/chat/completions</code> sin
            indicar modelo. Un pedido en formato Anthropic (<code className="text-default font-mono">/v1/messages</code>)
            se rechaza si este modelo no es de Anthropic, y al revés.
          </p>
        )}

        {(canDelegate || form.delegates) && (
          <div className="flex items-start gap-2.5 text-sm text-default">
            <input
              id="agent-delegates"
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={form.delegates}
              disabled={!canDelegate}
              aria-describedby="agent-delegates-hint"
              onChange={e => set('delegates', e.target.checked)}
            />
            <div>
              <label htmlFor="agent-delegates">Actúa por personas</label>
              <p id="agent-delegates-hint" className="text-xs text-muted mt-0.5">
                Para aplicaciones como un portal de chat: con el header{' '}
                <code className="text-default font-mono">X-Stratum-User</code> cada pedido sigue la política del
                equipo de esa persona y su consumo queda registrado como suyo. La key puede actuar por cualquier
                persona de la organización: guardala como un secreto del servidor, nunca en un navegador.
              </p>
            </div>
          </div>
        )}

        {!isEdit && (
          <div className="bg-raised border border-border rounded-md p-3 text-xs text-muted">
            Se genera una key con prefijo <code className="text-default font-mono">aig_agt_</code>, que se muestra
            una sola vez.
          </div>
        )}

        {error && <p role="alert" className="text-xs text-err">{error}</p>}

        <div className="flex gap-2 pt-1">
          <Btn variant="secondary" onClick={onClose} className="flex-1">Cancelar</Btn>
          <Btn onClick={submit} disabled={saving} className="flex-1">
            {saving ? 'Guardando…' : isEdit ? 'Guardar cambios' : 'Crear agente'}
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
      <div className="text-sm text-strong tabular">{children}</div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function AgentsPage() {
  const { can, scope } = usePermissions()
  const canManage = can('keys.manage')
  const canDelegate = scope('keys.manage') === 'org'
  const canUsage  = can('usage.read')
  const [agents,    setAgents]    = useState([])
  const [teams,     setTeams]     = useState([])
  const [models,    setModels]    = useState([])
  const [loading,   setLoading]   = useState(true)
  const [modal,     setModal]     = useState(null)
  const [revealKey, setRevealKey] = useState(null)
  const [rotating,  setRotating]  = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [a, t, m] = await Promise.all([
      fetch('/api/agents').then(r => r.json()),
      fetch('/api/teams').then(r => r.json()),
      fetch('/api/models').then(r => r.json()),
    ])
    setAgents(a); setTeams(t); setModels(m); setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function toggleActive(agent) {
    await fetch(`/api/agents/${agent.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !agent.is_active }),
    })
    load()
  }

  async function revokeKey(agent) {
    if (!window.confirm(`¿Revocar la key de ${agent.name}? Los gateways dejan de aceptarla en el próximo sync.`)) return
    const res = await fetch(`/api/agents/${agent.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove-key' }),
    })
    if (!res.ok) window.alert((await res.json()).message ?? 'No se pudo revocar la key.')
    load()
  }

  async function rotateKey(agent) {
    setRotating(agent.id)
    const res  = await fetch(`/api/agents/${agent.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rotate-key' }),
    })
    const data = await res.json()
    setRotating(null)
    if (data.apiKey) setRevealKey(data.apiKey)
  }

  function handleSave(data) {
    setModal(null)
    if (data.apiKey) setRevealKey(data.apiKey)
    load()
  }

  const action = 'min-h-[36px] px-2.5 rounded-md text-[13px] text-accent hover:bg-accent-light disabled:opacity-40'

  return (
    <div className="px-4 py-6 md:px-10 md:py-8 max-w-screen-xl space-y-6">

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-[26px] font-semibold text-strong tracking-tight">Agentes</h1>
          <p className="text-sm text-muted">
            Procesos automáticos (bots, pipelines, flujos) con su propia key, su política y su consumo.
          </p>
        </div>
        {canManage && <Btn onClick={() => setModal('create')}>+ Nuevo agente</Btn>}
      </div>

      {loading && <p className="text-sm text-muted">Cargando…</p>}

      {!loading && agents.length === 0 && (
        <div className="bg-card border border-border rounded-[10px] px-8 py-14 text-center space-y-1">
          <div className="text-sm font-medium text-strong">Todavía no hay agentes</div>
          <div className="text-sm text-muted">
            Cada agente llama al gateway con su key y su consumo se ve aparte del de las personas.
          </div>
        </div>
      )}

      {!loading && agents.length > 0 && (
        <div className="space-y-3">
          {agents.map(agent => (
            <div
              key={agent.id}
              data-testid="agent-row"
              className={`bg-card border border-border rounded-[10px] ${!agent.is_active ? 'opacity-60' : ''}`}
            >
              <div className="px-5 py-4 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-strong">{agent.name}</div>
                    {agent.description && <div className="text-xs text-muted mt-0.5">{agent.description}</div>}
                  </div>
                  {agent.team_name && (
                    <span className="text-xs text-default border border-border rounded px-2 py-0.5">{agent.team_name}</span>
                  )}
                  {agent.default_model ? (
                    <span className="text-xs font-mono text-default border border-border rounded px-2 py-0.5" title="Todos los pedidos de este agente van a este modelo">
                      → {agent.default_provider ? `${agent.default_provider}/` : ''}{agent.default_model}
                    </span>
                  ) : (
                    <span className="text-xs text-muted">el agente elige el modelo</span>
                  )}
                  {agent.delegates && (
                    <span className="text-xs text-accent border border-accent/40 rounded px-2 py-0.5" title="Su key puede actuar en nombre de personas (X-Stratum-User)">
                      actúa por personas
                    </span>
                  )}
                  {!agent.is_active && <span className="text-xs text-warn">desactivado</span>}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {canUsage && <Link href={`/usage?agent=${agent.id}`} className={`${action} inline-flex items-center`}>Ver consumo</Link>}
                  {canManage && (
                    <>
                      <button type="button" onClick={() => setModal({ agent })} className={action}>Editar</button>
                      <button type="button" onClick={() => rotateKey(agent)} disabled={rotating === agent.id} className={action}>
                        {rotating === agent.id ? '…' : 'Rotar key'}
                      </button>
                      {agent.api_key_prefix && (
                        <button type="button" onClick={() => revokeKey(agent)} className={`${action} !text-err hover:!bg-err-light`}>Revocar key</button>
                      )}
                      <button type="button" onClick={() => toggleActive(agent)} className={action}>
                        {agent.is_active ? 'Desactivar' : 'Activar'}
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="px-5 py-3 border-t border-border grid grid-cols-2 sm:grid-cols-4 gap-4">
                <Metric label="Requests del mes">{Number(agent.requests_month).toLocaleString('es-UY')}</Metric>
                <Metric label="Tokens">{formatTokens(agent.tokens_month)}</Metric>
                <Metric label="Costo estimado">{formatCost(agent.cost_month)}</Metric>
                <Metric label="Prefijo de la key"><span className="font-mono text-muted">{agent.api_key_prefix ?? '—'}</span></Metric>
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="bg-card border border-border rounded-[10px] p-5 space-y-3">
        <h2 className="text-sm font-semibold text-strong">Cómo funcionan</h2>
        <div className="grid gap-5 md:grid-cols-3 text-sm text-muted">
          <div className="space-y-1">
            <div className="text-strong font-medium">1. Creá el agente</div>
            Se genera una key <code className="text-default font-mono">aig_agt_</code>. El agente usa la política de su
            equipo: los mismos modelos permitidos y cuotas.
          </div>
          <div className="space-y-1">
            <div className="text-strong font-medium">2. Configuralo</div>
            Poné la key en su entorno y apuntá la URL base al gateway. Si ya usa los SDK de OpenAI o Anthropic, no
            hace falta cambiar código.
          </div>
          <div className="space-y-1">
            <div className="text-strong font-medium">3. Seguí su consumo</div>
            Cada request queda con el agente que lo hizo. En Consumo lo ves por agente, con su evolución, errores y
            latencia.
          </div>
        </div>
      </section>

      {modal === 'create' && <AgentModal teams={teams} models={models} canDelegate={canDelegate} onSave={handleSave} onClose={() => setModal(null)} />}
      {modal?.agent && <AgentModal agent={modal.agent} teams={teams} models={models} canDelegate={canDelegate} onSave={handleSave} onClose={() => setModal(null)} />}
      {revealKey && <KeyReveal apiKey={revealKey} onClose={() => setRevealKey(null)} />}
    </div>
  )
}
