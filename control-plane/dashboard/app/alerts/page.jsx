'use client'

import { useState, useEffect, useCallback } from 'react'
import Modal, { Field, Input, Select, Btn } from '../../components/Modal'

const ALERT_TYPES = [
  { value: 'budget', label: 'Budget mensual (USD)' },
  { value: 'quota',  label: 'Quota de tokens mensual' },
]

const CHANNELS = [
  { value: 'email', label: 'Email' },
  { value: 'slack', label: 'Slack (webhook)' },
]

const THRESHOLDS = [50, 70, 80, 90, 100]

// ─── Create modal ─────────────────────────────────────────────────────────────
function AlertModal({ teams, onSave, onClose }) {
  const [form, setForm] = useState({
    teamId:       '',
    alertType:    'budget',
    thresholdPct: 80,
    channel:      'email',
    destination:  '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function submit() {
    if (!form.teamId || !form.destination) {
      setError('Team and destination are required')
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
      if (!res.ok) { setError(data.error ?? 'Error saving'); return }
      onSave(data)
    } catch { setError('Connection error') }
    finally { setSaving(false) }
  }

  return (
    <Modal title="New alert" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Team">
          <Select value={form.teamId} onChange={e => set('teamId', e.target.value)}>
            <option value="">Select team…</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Alert when">
            <Select value={form.alertType} onChange={e => set('alertType', e.target.value)}>
              {ALERT_TYPES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
            </Select>
          </Field>
          <Field label="Threshold">
            <Select value={form.thresholdPct} onChange={e => set('thresholdPct', parseInt(e.target.value))}>
              {THRESHOLDS.map(t => <option key={t} value={t}>{t}%</option>)}
            </Select>
          </Field>
        </div>

        <Field label="Channel">
          <Select value={form.channel} onChange={e => set('channel', e.target.value)}>
            {CHANNELS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
        </Field>

        <Field
          label={form.channel === 'email' ? 'Email address' : 'Slack webhook URL'}
          hint={form.channel === 'slack'
            ? 'Get it from: Slack → Your workspace → Apps → Incoming Webhooks'
            : 'Alert will be sent to this address'}
        >
          <Input
            type={form.channel === 'email' ? 'email' : 'url'}
            placeholder={form.channel === 'email'
              ? 'cto@company.com'
              : 'https://hooks.slack.com/services/...'}
            value={form.destination}
            onChange={e => set('destination', e.target.value)}
          />
        </Field>

        {/* Preview */}
        {form.teamId && form.destination && (
          <div className="bg-raised border border-line rounded p-3 text-2xs text-lo space-y-1">
            <div className="text-mid font-medium">Preview</div>
            <div>
              When <span className="text-hi">{teams.find(t => t.id === form.teamId)?.name ?? '—'}</span> reaches{' '}
              <span className="text-hi">{form.thresholdPct}%</span> of its monthly{' '}
              <span className="text-hi">{form.alertType}</span>, send a{' '}
              <span className="text-hi">{form.channel}</span> to{' '}
              <span className="text-hi font-mono">{form.destination.length > 40 ? form.destination.slice(0, 40) + '…' : form.destination}</span>.
            </div>
          </div>
        )}

        {error && <p className="text-xs text-err">{error}</p>}
        <div className="flex gap-2 pt-1">
          <Btn variant="secondary" onClick={onClose} className="flex-1">Cancel</Btn>
          <Btn onClick={submit} disabled={saving} className="flex-1">
            {saving ? 'Saving…' : 'Create alert'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

// ─── Alert row ────────────────────────────────────────────────────────────────
function AlertRow({ alert, onToggle, onDelete, onReset }) {
  const firedToday = alert.last_fired_at
    && new Date(alert.last_fired_at).toDateString() === new Date().toDateString()

  return (
    <tr className={`hover:bg-overlay/40 transition-colors ${!alert.is_active ? 'opacity-40' : ''}`}>
      <td className="px-5 py-3.5">
        <div className="text-xs text-hi font-medium">{alert.team_name}</div>
      </td>
      <td className="px-5 py-3.5 text-xs text-mid">
        {alert.alert_type === 'budget' ? 'Monthly budget' : 'Token quota'}
      </td>
      <td className="px-5 py-3.5 text-xs text-hi font-mono">{alert.threshold_pct}%</td>
      <td className="px-5 py-3.5 text-2xs text-mid">{alert.channel}</td>
      <td className="px-5 py-3.5 text-2xs text-lo font-mono max-w-xs truncate">
        {alert.destination}
      </td>
      <td className="px-5 py-3.5">
        {firedToday ? (
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-warn flex-shrink-0" />
            <span className="text-2xs text-warn">Fired today</span>
          </div>
        ) : alert.last_fired_at ? (
          <span className="text-2xs text-lo">
            {new Date(alert.last_fired_at).toLocaleDateString()}
          </span>
        ) : (
          <span className="text-2xs text-lo opacity-40">Never</span>
        )}
      </td>
      <td className="px-5 py-3.5">
        <div className="flex items-center gap-3 justify-end">
          {firedToday && (
            <button
              onClick={() => onReset(alert)}
              className="text-2xs text-lo hover:text-mid transition-colors"
              title="Reset so it can fire again today"
            >
              Reset
            </button>
          )}
          <button
            onClick={() => onToggle(alert)}
            className={`text-2xs transition-colors ${alert.is_active ? 'text-lo hover:text-err' : 'text-lo hover:text-ok'}`}
          >
            {alert.is_active ? 'Disable' : 'Enable'}
          </button>
          <button
            onClick={() => onDelete(alert)}
            className="text-2xs text-lo hover:text-err transition-colors"
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function AlertsPage() {
  const [alerts,  setAlerts]  = useState([])
  const [teams,   setTeams]   = useState([])
  const [loading, setLoading] = useState(true)
  const [modal,   setModal]   = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [a, t] = await Promise.all([
      fetch('/api/alerts').then(r => r.json()),
      fetch('/api/teams').then(r => r.json()),
    ])
    setAlerts(a); setTeams(t); setLoading(false)
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
    if (!confirm(`Delete alert for ${alert.team_name}?`)) return
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
    <div className="px-8 py-7 max-w-screen-xl">

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-sm font-medium text-hi">Alerts</h1>
          <p className="text-xs text-lo mt-0.5">
            Get notified when a team approaches its budget or token limit
          </p>
        </div>
        <Btn onClick={() => setModal(true)}>+ New alert</Btn>
      </div>

      {/* How it works callout */}
      <div className="bg-raised border border-line rounded-lg p-4 mb-6 grid grid-cols-3 gap-5">
        {[
          { step: '01', title: 'Set a threshold', desc: 'Choose when to be notified — typically 80% gives time to act before hitting the limit.' },
          { step: '02', title: 'Pick a channel', desc: 'Email to a person or team. Slack to a channel via webhook. Both channels can be configured per team.' },
          { step: '03', title: 'Stratum fires it', desc: 'After each AI request, Stratum checks the threshold. Alerts fire once per day to avoid spam.' },
        ].map(({ step, title, desc }) => (
          <div key={step}>
            <div className="text-2xs text-lo font-mono mb-1">{step}</div>
            <div className="text-xs text-hi font-medium mb-1">{title}</div>
            <div className="text-2xs text-lo leading-relaxed">{desc}</div>
          </div>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-center text-lo text-xs py-10">Loading…</div>
      ) : alerts.length === 0 ? (
        <div className="bg-raised border border-line rounded-lg px-8 py-16 text-center">
          <div className="text-xs text-lo mb-1">No alerts configured</div>
          <div className="text-2xs text-lo opacity-60">
            Create an alert to get notified when a team is approaching its budget or token limit.
          </div>
        </div>
      ) : (
        <div className="bg-raised border border-line rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="text-2xs text-lo uppercase tracking-widest border-b border-line">
                <th className="px-5 py-3 text-left font-medium">Team</th>
                <th className="px-5 py-3 text-left font-medium">Type</th>
                <th className="px-5 py-3 text-left font-medium">At</th>
                <th className="px-5 py-3 text-left font-medium">Channel</th>
                <th className="px-5 py-3 text-left font-medium">Destination</th>
                <th className="px-5 py-3 text-left font-medium">Last fired</th>
                <th className="px-5 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {alerts.map(alert => (
                <AlertRow
                  key={alert.id}
                  alert={alert}
                  onToggle={toggle}
                  onDelete={del}
                  onReset={reset}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

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
