'use client'

import { useState, useEffect, useCallback } from 'react'
import Modal, { Field, Input, Btn } from '../../components/Modal'

const API = '/api/internal/instances'

const STATUS = {
  online:   { label: 'Sincronizado', cls: 'text-ok' },
  stale:    { label: 'Atrasado',     cls: 'text-warn' },
  offline:  { label: 'Sin contacto', cls: 'text-err' },
  never:    { label: 'Nunca se conectó', cls: 'text-subtle' },
  disabled: { label: 'Dado de baja', cls: 'text-subtle' },
}

function ago(seconds) {
  if (seconds == null) return '—'
  if (seconds < 60) return `hace ${seconds} s`
  if (seconds < 3600) return `hace ${Math.floor(seconds / 60)} min`
  if (seconds < 86400) return `hace ${Math.floor(seconds / 3600)} h`
  return `hace ${Math.floor(seconds / 86400)} d`
}

function Copy({ text }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) } catch {}
      }}
      className="text-xs text-accent hover:text-accent-hover"
    >
      {done ? 'Copiado' : 'Copiar'}
    </button>
  )
}

// A labelled read-only value (not a form field: it holds a copy button).
function Value({ label, children }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-semibold text-muted uppercase tracking-wide">{label}</div>
      {children}
    </div>
  )
}

// Shown once, after registering or rotating: the token is not stored anywhere readable.
function TokenModal({ result, cpUrl, onClose }) {
  const env = `STRATUM_CP_URL=${cpUrl}\nSTRATUM_INSTANCE_ID=${result.id}\nSTRATUM_SYNC_TOKEN=${result.sync_token}`
  return (
    <Modal title={`Credenciales de ${result.name}`} onClose={onClose} width="max-w-2xl">
      <div className="space-y-4">
        <p className="text-xs text-warn bg-warn-light rounded-lg px-3 py-2">
          El sync token se muestra una sola vez. Guardalo ahora en el gestor de secretos del gateway.
        </p>
        <Value label="Instance ID">
          <div className="flex items-center gap-3"><code data-testid="instance-id" className="text-sm break-all">{result.id}</code><Copy text={result.id} /></div>
        </Value>
        <Value label="Sync token">
          <div className="flex items-center gap-3"><code data-testid="sync-token" className="text-sm break-all">{result.sync_token}</code><Copy text={result.sync_token} /></div>
        </Value>
        <Value label="Variables de entorno del gateway">
          <div className="relative">
            <pre className="text-xs bg-raised border border-border rounded-lg p-3 overflow-x-auto">{env}</pre>
            <div className="absolute top-2 right-3"><Copy text={env} /></div>
          </div>
        </Value>
        <div className="flex justify-end"><Btn onClick={onClose}>Ya lo guardé</Btn></div>
      </div>
    </Modal>
  )
}

function RegisterModal({ onClose, onDone }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true); setError('')
    const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
    const data = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) return setError(data.message ?? 'No se pudo registrar.')
    onDone(data)
  }

  return (
    <Modal title="Registrar gateway" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Nombre" hint="Para reconocerlo en la consola: dónde corre, por ejemplo ar-prod o pc-local.">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="ar-prod" autoFocus />
        </Field>
        {error && <p className="text-xs text-err bg-err-light rounded-lg px-3 py-2">{error}</p>}
        <div className="flex justify-end gap-2">
          <Btn variant="secondary" onClick={onClose}>Cancelar</Btn>
          <Btn onClick={save} disabled={saving || !name.trim()}>{saving ? 'Registrando…' : 'Registrar'}</Btn>
        </div>
      </div>
    </Modal>
  )
}

export default function GatewaysPage() {
  const [data, setData]           = useState({ instances: [], current_version: null })
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')
  const [canManage, setCanManage] = useState(false)
  const [modal, setModal]         = useState(null)
  const [cpUrl, setCpUrl]         = useState('')

  const load = useCallback(async () => {
    const res = await fetch(API)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) setError(body.message ?? 'No se pudieron cargar los gateways.')
    else setData(body)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    setCpUrl(window.location.origin)
    fetch('/api/session').then(r => r.json()).then(me => setCanManage(me.permissions?.['gateways.manage'] === 'org')).catch(() => {})
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [load])

  async function rotate(gw) {
    if (!window.confirm(`¿Generar un sync token nuevo para ${gw.name}? El actual deja de funcionar ya: el gateway sigue sirviendo con su última configuración hasta que le cargues el nuevo.`)) return
    const res = await fetch(`${API}?id=${gw.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rotate-token' }) })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return window.alert(body.message ?? 'No se pudo rotar el token.')
    setModal({ token: body })
    load()
  }

  async function disable(gw) {
    if (!window.confirm(`¿Dar de baja ${gw.name}? Su token deja de funcionar: el gateway ya no recibe cambios de configuración.`)) return
    const res = await fetch(`${API}?id=${gw.id}`, { method: 'DELETE' })
    if (!res.ok) window.alert((await res.json().catch(() => ({}))).message ?? 'No se pudo dar de baja.')
    load()
  }

  return (
    <div className="p-7 max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div className="max-w-2xl">
          <h1 className="text-lg font-semibold text-strong">Gateways</h1>
          <p className="text-sm text-muted mt-1">
            Los gateways corren en tu infraestructura y le piden la configuración a este control plane cada 30 s.
            Si el control plane no responde, siguen sirviendo con la última que tienen.
          </p>
        </div>
        {canManage && <Btn onClick={() => setModal({ register: true })}>Registrar gateway</Btn>}
      </div>

      {error && <p className="text-sm text-err bg-err-light rounded-lg px-4 py-3 mb-4">{error}</p>}

      <div className="bg-card border border-border rounded-xl overflow-x-auto">
        {loading ? (
          <p className="p-6 text-sm text-muted">Cargando…</p>
        ) : data.instances.length === 0 ? (
          <p className="p-8 text-sm text-muted">Todavía no hay gateways registrados.</p>
        ) : (
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted border-b border-border">
                <th className="px-5 py-3 font-semibold">Gateway</th>
                <th className="px-4 py-3 font-semibold">Estado</th>
                <th className="px-4 py-3 font-semibold">Última sincronización</th>
                <th className="px-4 py-3 font-semibold">Configuración</th>
                <th className="px-5 py-3"><span className="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              {data.instances.map(gw => {
                const st = STATUS[gw.status] ?? STATUS.offline
                const current = gw.last_version != null && data.current_version != null && Number(gw.last_version) >= data.current_version
                return (
                  <tr key={gw.id} className={`border-b border-border last:border-0 ${gw.disabled ? 'opacity-60' : ''}`}>
                    <td className="px-5 py-3.5">
                      <div className="font-semibold text-strong">{gw.name}</div>
                      <code className="text-xs text-muted">{gw.id}</code>
                    </td>
                    <td className={`px-4 py-3.5 text-xs font-semibold ${st.cls}`}>● {st.label}</td>
                    <td className="px-4 py-3.5 text-muted">{ago(gw.seconds_since_sync)}</td>
                    <td className="px-4 py-3.5 text-muted">
                      {gw.last_version == null || gw.status === 'never' ? '—' : <>v{gw.last_version} {current ? <span className="text-ok">(actual)</span> : <span className="text-warn">(actual: v{data.current_version})</span>}</>}
                    </td>
                    <td className="px-5 py-3.5">
                      {canManage && !gw.disabled && (
                        <div className="flex justify-end gap-1">
                          <button onClick={() => rotate(gw)} className="text-xs text-muted hover:text-default px-2 py-1 rounded hover:bg-raised">Rotar token</button>
                          <button onClick={() => disable(gw)} className="text-xs text-err px-2 py-1 rounded hover:bg-raised">Dar de baja</button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {modal?.register && <RegisterModal onClose={() => setModal(null)} onDone={r => { setModal({ token: r }); load() }} />}
      {modal?.token && <TokenModal result={modal.token} cpUrl={cpUrl} onClose={() => setModal(null)} />}
    </div>
  )
}
