'use client'

// Service tokens: the console's API for automation (lib/service-tokens.js):
// scripts, Terraform, an identity bridge that provisions people.

import { useState, useEffect, useCallback } from 'react'
import Modal, { Field, Input, Btn } from '../../components/Modal'
import { usePermissions } from '../../components/usePermissions'

// What each permission lets a token do, in words.
const SCOPE_LABEL = {
  'users.read':      'Ver usuarios',
  'users.manage':    'Dar de alta, modificar y desactivar usuarios (nunca Owners, contraseñas ni keys de personas)',
  'keys.manage':     'Crear agentes y rotar sus keys',
  'teams.read':      'Ver equipos',
  'teams.manage':    'Crear y modificar equipos',
  'teams.budget':    'Cambiar presupuestos de equipos',
  'policies.read':   'Ver políticas',
  'policies.manage': 'Crear y modificar políticas',
  'alerts.read':     'Ver alertas',
  'alerts.manage':   'Crear y modificar alertas',
  'models.read':     'Ver modelos',
  'models.manage':   'Modificar el catálogo de modelos',
  'providers.read':  'Ver proveedores (sin sus claves)',
  'gateways.read':   'Ver gateways',
  'apps.read':       'Ver aplicaciones',
  'sso.read':        'Ver el ingreso con SSO',
  'usage.read':      'Ver consumo',
  'logs.read':       'Ver requests',
  'audit.read':      'Ver la auditoría',
}

const day = (t) => (t ? new Date(t).toLocaleDateString('es-UY', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')

function Reveal({ token, value, onClose }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* stays selectable */ }
  }
  return (
    <Modal title={`Token «${token.name}»`} onClose={onClose} width="max-w-md">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Es la única vez que se muestra. Guardalo en el gestor de secretos de la automatización que lo va a usar:
          va en el encabezado <code className="font-mono">Authorization: Bearer …</code>.
        </p>
        <div className="flex gap-2">
          <code data-testid="revealed-token" className="flex-1 bg-app border border-border rounded-md px-3 py-2 font-mono text-xs text-strong break-all select-all">{value}</code>
          <button type="button" onClick={copy}
            className="flex-shrink-0 min-h-[40px] bg-card border border-border-strong rounded-md px-3 text-xs text-strong">
            {copied ? 'Copiado' : 'Copiar'}
          </button>
        </div>
        <Btn variant="secondary" onClick={onClose} className="w-full">Ya lo guardé, cerrar</Btn>
      </div>
    </Modal>
  )
}

function NewToken({ scopes, choices, onSave, onClose }) {
  const [name, setName] = useState('')
  const [picked, setPicked] = useState([])
  const [days, setDays] = useState(90)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const toggle = (s) => setPicked(p => (p.includes(s) ? p.filter(x => x !== s) : [...p, s]))

  async function submit() {
    setSaving(true); setError('')
    try {
      const res = await fetch('/api/service-tokens', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, scopes: picked, expiresInDays: days }),
      })
      const d = await res.json()
      if (!res.ok) { setError(d.message ?? 'No se pudo crear.'); return }
      onSave(d)
    } catch { setError('No se pudo conectar con la consola.') }
    finally { setSaving(false) }
  }

  return (
    <Modal title="Nuevo token de servicio" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Nombre *" hint="Lo que lo usa: aparece así en Auditoría, como «token:nombre».">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="terraform" autoFocus />
        </Field>
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-default mb-1">Permisos *</legend>
          <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
            {scopes.map(s => (
              <label key={s} className="flex items-start gap-2.5 text-sm text-default">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={picked.includes(s)} onChange={() => toggle(s)} />
                <span>{SCOPE_LABEL[s] ?? s} <code className="text-xs text-muted font-mono">{s}</code></span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Vence en">
          <select value={days} onChange={e => setDays(Number(e.target.value))}
            className="w-full h-10 bg-raised border border-border rounded-md px-3 text-sm text-strong">
            {choices.map(d => <option key={d} value={d}>{d} días</option>)}
          </select>
        </Field>
        {error && <p role="alert" className="text-xs text-err">{error}</p>}
        <div className="flex gap-2 pt-1">
          <Btn variant="secondary" onClick={onClose} className="flex-1">Cancelar</Btn>
          <Btn onClick={submit} disabled={saving || !name.trim() || !picked.length} className="flex-1">
            {saving ? 'Creando…' : 'Crear token'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

export default function ServiceTokensPage() {
  const { can } = usePermissions()
  const canManage = can('tokens.manage')
  const [data, setData] = useState(null)
  const [creating, setCreating] = useState(false)
  const [reveal, setReveal] = useState(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/service-tokens')
    setData(res.ok ? await res.json() : { tokens: [], scopes: [], expiryChoices: [] })
  }, [])
  useEffect(() => { load() }, [load])

  async function revoke(t) {
    if (!window.confirm(`¿Revocar «${t.name}»? Lo que lo use deja de funcionar ya.`)) return
    const res = await fetch(`/api/service-tokens/${t.id}`, { method: 'DELETE' })
    if (!res.ok) window.alert((await res.json()).message ?? 'No se pudo revocar.')
    load()
  }

  const now = Date.now()
  return (
    <div className="px-4 py-6 md:px-10 md:py-8 max-w-screen-xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-[26px] font-semibold text-strong tracking-tight">Tokens de servicio</h1>
          <p className="text-sm text-muted max-w-2xl">
            Para automatizar la consola desde scripts, Terraform o un servicio que da de alta personas. Cada token tiene
            solo los permisos que le des, vence en un año como máximo y queda en Auditoría con su nombre. No inicia
            sesión, no define contraseñas, no crea Owners ni otros tokens.
          </p>
        </div>
        {canManage && data && <Btn onClick={() => setCreating(true)}>+ Nuevo token</Btn>}
      </div>

      <div className="bg-card border border-border rounded-[10px] divide-y divide-border">
        {!data ? (
          <p className="px-5 py-8 text-sm text-muted">Cargando…</p>
        ) : data.tokens.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted">Todavía no hay tokens.</p>
        ) : data.tokens.map(t => {
          const expired = new Date(t.expires_at).getTime() <= now
          const off = t.revoked_at || expired
          return (
            <div key={t.id} data-testid="service-token" className={`px-5 py-4 flex flex-wrap items-start justify-between gap-3 ${off ? 'opacity-60' : ''}`}>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-strong">{t.name}</span>
                  <code className="text-xs font-mono text-muted">{t.token_prefix}…</code>
                  {t.revoked_at && <span className="text-xs text-warn">revocado</span>}
                  {!t.revoked_at && expired && <span className="text-xs text-warn">vencido</span>}
                </div>
                <div className="flex flex-wrap gap-1">
                  {t.scopes.map(s => <span key={s} className="text-xs text-default border border-border rounded px-2 py-0.5 font-mono">{s}</span>)}
                </div>
                <div className="text-xs text-muted">
                  Creado el {day(t.created_at)}{t.created_by_email ? ` por ${t.created_by_email}` : ''} · vence el {day(t.expires_at)} ·
                  {t.last_used_at ? ` usado por última vez el ${day(t.last_used_at)}` : ' nunca usado'}
                </div>
              </div>
              {canManage && !t.revoked_at && (
                <button type="button" onClick={() => revoke(t)}
                  className="min-h-[36px] px-2.5 rounded-md text-[13px] text-err hover:bg-err-light">Revocar</button>
              )}
            </div>
          )
        })}
      </div>

      {creating && data && (
        <NewToken scopes={data.scopes} choices={data.expiryChoices}
          onClose={() => setCreating(false)}
          onSave={(d) => { setCreating(false); setReveal(d); load() }} />
      )}
      {reveal && <Reveal token={reveal.token} value={reveal.value} onClose={() => setReveal(null)} />}
    </div>
  )
}
