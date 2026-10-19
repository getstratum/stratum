'use client'

import { useState, useEffect, useCallback } from 'react'
import Modal, { Field, Input, Select, Btn } from '../../components/Modal'
import { usePermissions } from '../../components/usePermissions'
import { formatDateTime } from '../../lib/format'

const ALERT_TYPES = [
  { value: 'quota',  label: 'Cuota de tokens del mes' },
  { value: 'budget', label: 'Presupuesto del mes (US$)' },
]
const TYPE_LABEL = { quota: 'Cuota de tokens', budget: 'Presupuesto', policy_violation: 'Pedido rechazado por la política' }

const CHANNELS = [
  { value: 'email', label: 'Email' },
  { value: 'slack', label: 'Slack (webhook)' },
]
const CHANNEL_LABEL = { email: 'Email', slack: 'Slack' }

const THRESHOLDS = [50, 70, 80, 90, 100]

// ─── Create modal ─────────────────────────────────────────────────────────────
function AlertModal({ teams, onSave, onClose }) {
  const [form, setForm] = useState({
    teamId:       '',
    alertType:    'quota',
    thresholdPct: 80,
    channel:      'email',
    destination:  '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function submit() {
    if (!form.teamId || !form.destination) {
      setError('El equipo y el destino son obligatorios.')
      return
    }
    setSaving(true); setError('')
    try {
      const res  = await fetch('/api/alerts', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.message ?? data.error ?? 'No se pudo guardar.'); return }
      onSave(data)
    } catch { setError('No se pudo conectar con la consola.') }
    finally { setSaving(false) }
  }

  return (
    <Modal title="Nueva alerta" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Equipo">
          <Select value={form.teamId} onChange={e => set('teamId', e.target.value)}>
            <option value="">Elegí un equipo…</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Avisar cuando">
            <Select value={form.alertType} onChange={e => set('alertType', e.target.value)}>
              {ALERT_TYPES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
            </Select>
          </Field>
          <Field label="Umbral">
            <Select value={form.thresholdPct} onChange={e => set('thresholdPct', parseInt(e.target.value))}>
              {THRESHOLDS.map(t => <option key={t} value={t}>{t} %</option>)}
            </Select>
          </Field>
        </div>

        <Field label="Canal">
          <Select value={form.channel} onChange={e => set('channel', e.target.value)}>
            {CHANNELS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
        </Field>

        <Field
          label={form.channel === 'email' ? 'Dirección de email' : 'URL del webhook de Slack'}
          hint={form.channel === 'slack'
            ? 'En Slack: tu espacio de trabajo → Apps → Incoming Webhooks.'
            : 'Una persona o una lista del equipo.'}
        >
          <Input
            type={form.channel === 'email' ? 'email' : 'url'}
            placeholder={form.channel === 'email'
              ? 'finanzas@empresa.com'
              : 'https://hooks.slack.com/services/...'}
            value={form.destination}
            onChange={e => set('destination', e.target.value)}
          />
        </Field>

        {/* Preview */}
        {form.teamId && form.destination && (
          <div className="bg-raised border border-border rounded-md p-3 text-sm text-muted">
            Cuando <span className="text-strong">{teams.find(t => t.id === form.teamId)?.name ?? '—'}</span> llegue
            al <span className="text-strong tabular">{form.thresholdPct} %</span> de su{' '}
            {form.alertType === 'quota' ? 'cuota de tokens' : 'presupuesto'} del mes, avisar por{' '}
            {CHANNEL_LABEL[form.channel]} a{' '}
            <span className="text-strong font-mono break-all">{form.destination.length > 40 ? form.destination.slice(0, 40) + '…' : form.destination}</span>.
          </div>
        )}

        {error && <p role="alert" className="text-sm text-err">{error}</p>}
        <div className="flex gap-2 pt-1">
          <Btn variant="secondary" onClick={onClose} className="flex-1">Cancelar</Btn>
          <Btn onClick={submit} disabled={saving} className="flex-1">
            {saving ? 'Guardando…' : 'Crear alerta'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

// ─── Alert row ────────────────────────────────────────────────────────────────
function AlertRow({ alert, canManage, onToggle, onDelete, onReset }) {
  const firedToday = alert.last_fired_at
    && new Date(alert.last_fired_at).toDateString() === new Date().toDateString()
  const action = 'min-h-[36px] px-2.5 rounded-md text-[13px] text-accent hover:bg-accent-light whitespace-nowrap'

  return (
    <tr className={!alert.is_active ? 'opacity-60' : ''}>
      <td className="px-4 py-3 text-sm text-strong font-medium">{alert.team_name ?? 'Toda la organización'}</td>
      <td className="px-4 py-3 text-sm text-default">{TYPE_LABEL[alert.alert_type] ?? alert.alert_type}</td>
      <td className="px-4 py-3 text-sm text-strong tabular text-right">{alert.threshold_pct} %</td>
      <td className="px-4 py-3 text-sm text-default">{CHANNEL_LABEL[alert.channel] ?? alert.channel}</td>
      <td className="px-4 py-3 text-xs text-muted font-mono max-w-[240px] truncate" title={alert.destination}>
        {alert.destination}
      </td>
      <td className="px-4 py-3 text-sm whitespace-nowrap">
        {firedToday
          ? <span className="text-warn">Hoy</span>
          : alert.last_fired_at
            ? <span className="text-muted tabular">{formatDateTime(alert.last_fired_at)}</span>
            : <span className="text-subtle">Nunca</span>}
        {!alert.is_active && <span className="text-xs text-warn ml-2">desactivada</span>}
      </td>
      {canManage && (
        <td className="px-4 py-2">
          <div className="flex items-center gap-1 justify-end">
            {firedToday && (
              <button type="button" onClick={() => onReset(alert)} className={action}
                      title="Permite que vuelva a avisar hoy">
                Reiniciar
              </button>
            )}
            <button type="button" onClick={() => onToggle(alert)} className={action}>
              {alert.is_active ? 'Desactivar' : 'Activar'}
            </button>
            <button type="button" onClick={() => onDelete(alert)} className={`${action} !text-err hover:!bg-err-light`}>
              Eliminar
            </button>
          </div>
        </td>
      )}
    </tr>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function AlertsPage() {
  const { can } = usePermissions()
  const canManage = can('alerts.manage')
  const [alerts,  setAlerts]  = useState([])
  const [teams,   setTeams]   = useState([])
  const [loading, setLoading] = useState(true)
  const [modal,   setModal]   = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [a, t] = await Promise.all([
      fetch('/api/alerts').then(r => (r.ok ? r.json() : [])),
      fetch('/api/teams').then(r => (r.ok ? r.json() : [])),
    ])
    setAlerts(Array.isArray(a) ? a : []); setTeams(Array.isArray(t) ? t : []); setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function toggle(alert) {
    await fetch(`/api/alerts/${alert.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !alert.is_active }),
    })
    load()
  }

  async function del(alert) {
    if (!window.confirm(`¿Eliminar la alerta de ${alert.team_name ?? 'toda la organización'}?`)) return
    await fetch(`/api/alerts/${alert.id}`, { method: 'DELETE' })
    load()
  }

  async function reset(alert) {
    await fetch(`/api/alerts/${alert.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetFired: true }),
    })
    load()
  }

  return (
    <div className="px-4 py-6 md:px-10 md:py-8 max-w-screen-xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-[26px] font-semibold text-strong tracking-tight">Alertas</h1>
          <p className="text-sm text-muted">
            Avisos para cuando un equipo se acerca a su cuota de tokens o a su presupuesto del mes.
          </p>
        </div>
        {canManage && <Btn onClick={() => setModal(true)}>+ Nueva alerta</Btn>}
      </div>

      <div className="bg-warn-light border border-warn/30 rounded-md px-4 py-3 text-sm text-warn">
        Esta versión guarda las alertas pero todavía no las envía: ningún aviso sale por email ni por Slack.
        Para seguir el consumo mientras tanto, usá Consumo y la cuota de cada equipo en Equipos.
      </div>

      {loading ? (
        <p className="text-sm text-muted">Cargando…</p>
      ) : alerts.length === 0 ? (
        <div className="bg-card border border-border rounded-[10px] px-8 py-14 text-center space-y-1">
          <div className="text-sm font-medium text-strong">Todavía no hay alertas</div>
          <div className="text-sm text-muted">
            {teams.length === 0
              ? 'Primero hace falta un equipo: las alertas se definen por equipo.'
              : 'Definí a partir de qué porcentaje avisar y a quién.'}
          </div>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-[10px] overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="text-xs text-muted uppercase tracking-wider bg-raised border-b border-border">
                <th className="px-4 py-3 text-left font-semibold">Equipo</th>
                <th className="px-4 py-3 text-left font-semibold">Sobre</th>
                <th className="px-4 py-3 text-right font-semibold">Umbral</th>
                <th className="px-4 py-3 text-left font-semibold">Canal</th>
                <th className="px-4 py-3 text-left font-semibold">Destino</th>
                <th className="px-4 py-3 text-left font-semibold">Último aviso</th>
                {canManage && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {alerts.map(alert => (
                <AlertRow
                  key={alert.id}
                  alert={alert}
                  canManage={canManage}
                  onToggle={toggle}
                  onDelete={del}
                  onReset={reset}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="bg-card border border-border rounded-[10px] p-5 space-y-3">
        <h2 className="text-sm font-semibold text-strong">Cómo funcionan</h2>
        <div className="grid gap-5 md:grid-cols-3 text-sm text-muted">
          <div className="space-y-1">
            <div className="text-strong font-medium">1. Elegí el umbral</div>
            Un porcentaje de la cuota de tokens o del presupuesto del equipo. Con 80 % suele haber tiempo de actuar.
          </div>
          <div className="space-y-1">
            <div className="text-strong font-medium">2. Elegí el canal</div>
            Email a una persona o lista, o Slack a un canal por webhook. Un equipo puede tener varias alertas.
          </div>
          <div className="space-y-1">
            <div className="text-strong font-medium">3. El aviso</div>
            Está previsto revisar el consumo y avisar una vez por día como máximo por alerta. Esta versión todavía no envía.
          </div>
        </div>
      </section>

      {modal && (
        <AlertModal
          teams={teams}
          onSave={() => { setModal(false); load() }}
          onClose={() => setModal(false)}
        />
      )}
    </div>
  )
}
