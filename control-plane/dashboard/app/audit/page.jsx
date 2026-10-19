'use client'

import { useState, useEffect, useCallback } from 'react'

// What each recorded action means, in the console's language. Unknown
// actions are shown as recorded.
const ACTIONS = {
  'session.login':          'Inicio de sesión',
  'permission.denied':      'Intento sin permiso',
  'user.create':            'Creó una persona',
  'user.update':            'Modificó una persona',
  'user.key.rotate':        'Rotó la API key de una persona',
  'user.key.revoke':        'Revocó la API key de una persona',
  'user.password.change':   'Cambió su contraseña',
  'user.password.reset':    'Reseteó una contraseña (CLI)',
  'session.password_ok':    'Contraseña correcta; falta el segundo paso',
  'mfa.setup':              'Empezó a configurar la verificación en dos pasos',
  'mfa.enable':             'Activó la verificación en dos pasos',
  'mfa.disable':            'Desactivó la verificación en dos pasos',
  'mfa.recovery_codes':     'Generó códigos de recuperación nuevos',
  'user.mfa.reset':         'Reinició la verificación en dos pasos de una persona',
  'owner.bootstrap':        'Creó o restauró un Owner (CLI)',
  'agent.create':           'Creó un agente',
  'agent.update':           'Modificó un agente',
  'agent.key.rotate':       'Rotó la key de un agente',
  'agent.key.revoke':       'Revocó la key de un agente',
  'team.create':            'Creó un equipo',
  'team.update':            'Modificó un equipo',
  'team.delete':            'Eliminó un equipo',
  'policy.create':          'Creó una política',
  'policy.update':          'Modificó una política',
  'policy.delete':          'Borró una política',
  'alert.create':           'Creó una alerta',
  'alert.update':           'Modificó una alerta',
  'alert.delete':           'Borró una alerta',
  'provider.create':        'Agregó un proveedor',
  'provider.replace':       'Reemplazó un proveedor',
  'provider.update':        'Modificó un proveedor',
  'provider.revoke':        'Revocó un proveedor',
  'provider.test':          'Probó la conexión de un proveedor',
  'gateway.register':       'Registró un gateway',
  'gateway.token.rotate':   'Rotó el token de un gateway',
  'gateway.disable':        'Dio de baja un gateway',
}

const RESULT = {
  ok:     { label: 'Hecho',     cls: 'text-ok' },
  denied: { label: 'Rechazado', cls: 'text-err' },
  failed: { label: 'Fallido',   cls: 'text-warn' },
}

const ROLE = { owner: 'Owner', admin: 'Admin', team_manager: 'Gestor/a de equipo', auditor: 'Auditor/a' }

function describe(e) {
  const d = e.details ?? {}
  const bits = []
  if (d.email) bits.push(d.email)
  if (d.name) bits.push(d.name)
  if (d.provider) bits.push(d.provider)
  if (d.permission) bits.push(`${d.permission} (${d.method} ${d.path})`)
  if (d.reason) bits.push(d.reason)
  if (Array.isArray(d.changed) && d.changed.length) bits.push(`cambió: ${d.changed.join(', ')}`)
  if (d.role?.from) bits.push(`rol ${d.role.from} → ${d.role.to}`)
  return bits.join(' · ')
}

export default function AuditPage() {
  const [entries, setEntries] = useState([])
  const [next, setNext]       = useState(null)
  const [filter, setFilter]   = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  const load = useCallback(async (before = null) => {
    setLoading(true)
    const q = new URLSearchParams({ limit: '100' })
    if (filter) q.set('result', filter)
    if (before) q.set('before', before)
    const res = await fetch(`/api/audit?${q}`)
    const data = await res.json().catch(() => ({}))
    setLoading(false)
    if (!res.ok) return setError(data.message ?? 'No se pudo cargar la auditoría.')
    setError('')
    setEntries(prev => (before ? [...prev, ...data.entries] : data.entries))
    setNext(data.next)
  }, [filter])

  useEffect(() => { load() }, [load])

  return (
    <div className="px-4 py-6 md:px-10 md:py-8 max-w-screen-xl">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div className="max-w-2xl">
          <h1 className="text-[26px] font-semibold text-strong tracking-tight">Auditoría</h1>
          <p className="text-sm text-muted mt-1">
            Cada cambio hecho en la consola, cada inicio de sesión y cada intento sin permiso. Nadie puede editar ni borrar estas entradas.
          </p>
        </div>
        <div>
          <label htmlFor="result" className="block text-xs font-semibold text-muted mb-1">Resultado</label>
          <select id="result" value={filter} onChange={e => setFilter(e.target.value)}
            className="bg-card border border-border rounded-lg px-3 py-2 text-sm">
            <option value="">Todos</option>
            <option value="denied">Rechazados</option>
            <option value="failed">Fallidos</option>
            <option value="ok">Hechos</option>
          </select>
        </div>
      </div>

      {error && <p className="text-sm text-err bg-err-light rounded-lg px-4 py-3 mb-4">{error}</p>}

      <div className="bg-card border border-border rounded-xl overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted border-b border-border">
              <th className="px-5 py-3 font-semibold">Fecha</th>
              <th className="px-4 py-3 font-semibold">Quién</th>
              <th className="px-4 py-3 font-semibold">Acción</th>
              <th className="px-4 py-3 font-semibold">Origen</th>
              <th className="px-5 py-3 font-semibold">Resultado</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(e => {
              const r = RESULT[e.result] ?? RESULT.ok
              return (
                <tr key={e.id} className={`border-b border-border last:border-0 align-top ${e.result === 'denied' ? 'bg-err-light/40' : ''}`}>
                  <td className="px-5 py-3 whitespace-nowrap text-muted tabular-nums">
                    {new Date(e.at).toLocaleString('es-UY', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-strong">{e.actor_label ?? '—'}</div>
                    <div className="text-xs text-muted">{ROLE[e.actor_role] ?? e.actor_role ?? ''}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{ACTIONS[e.action] ?? e.action}</div>
                    <div className="text-xs text-muted break-all">{describe(e)}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted"><code>{e.ip ?? '—'}</code></td>
                  <td className={`px-5 py-3 text-xs font-semibold ${r.cls}`}>{r.label}</td>
                </tr>
              )
            })}
            {!loading && entries.length === 0 && (
              <tr><td colSpan={5} className="px-5 py-8 text-sm text-muted">No hay entradas.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex justify-center">
        {loading ? <span className="text-sm text-muted">Cargando…</span> : next && (
          <button onClick={() => load(next)} className="text-sm text-accent hover:text-accent-hover px-3 py-2">Cargar más</button>
        )}
      </div>
    </div>
  )
}
