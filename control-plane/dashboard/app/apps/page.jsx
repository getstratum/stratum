'use client'

// Applications that sign people in with their console account (OIDC,
// lib/oidc.js): a chat portal, an internal tool.

import { useState, useEffect, useCallback } from 'react'
import Modal, { Field, Input, Btn } from '../../components/Modal'
import { usePermissions } from '../../components/usePermissions'

function SecretReveal({ app, secret, onClose }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* stays selectable */ }
  }
  return (
    <Modal title="Secreto de la aplicación" onClose={onClose} width="max-w-md">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Es la única vez que se muestra. Va en la configuración del servidor de {app.name}, nunca en un navegador.
        </p>
        <dl className="text-xs space-y-2">
          <div>
            <dt className="text-muted mb-1">client_id</dt>
            <dd><code className="block bg-app border border-border rounded-md px-3 py-2 font-mono text-strong break-all select-all">{app.id}</code></dd>
          </div>
          <div>
            <dt className="text-muted mb-1">client_secret</dt>
            <dd className="flex gap-2">
              <code data-testid="revealed-secret" className="flex-1 bg-app border border-border rounded-md px-3 py-2 font-mono text-strong break-all select-all">{secret}</code>
              <button type="button" onClick={copy}
                className="flex-shrink-0 min-h-[40px] bg-card border border-border-strong rounded-md px-3 text-xs text-strong">
                {copied ? 'Copiado' : 'Copiar'}
              </button>
            </dd>
          </div>
        </dl>
        <Btn variant="secondary" onClick={onClose} className="w-full">Ya lo guardé, cerrar</Btn>
      </div>
    </Modal>
  )
}

function AppModal({ app, onSave, onClose }) {
  const isEdit = !!app
  const [name, setName] = useState(app?.name ?? '')
  const [uris, setUris] = useState((app?.redirect_uris ?? []).join('\n'))
  const [requireMfa, setRequireMfa] = useState(app?.require_mfa ?? true)
  const [usageReports, setUsageReports] = useState(app?.usage_reports ?? false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setSaving(true); setError('')
    try {
      const res = await fetch(isEdit ? `/api/apps/${app.id}` : '/api/apps', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, redirectUris: uris.split('\n').map(s => s.trim()).filter(Boolean), requireMfa, usageReports }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.message ?? 'No se pudo guardar.'); return }
      onSave(data)
    } catch { setError('No se pudo conectar con la consola.') }
    finally { setSaving(false) }
  }

  return (
    <Modal title={isEdit ? 'Editar aplicación' : 'Nueva aplicación'} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Nombre *" hint="Lo ven las personas al ingresar: «Ingresá a …».">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Portal de chat" autoFocus />
        </Field>
        <Field label="Direcciones de retorno *" hint="Una por línea, exactas. https, o http en localhost para probar.">
          <textarea value={uris} onChange={e => setUris(e.target.value)} rows={3}
            placeholder="https://chat.acme.internal/auth/callback"
            className="w-full bg-raised border border-border rounded-md px-3 py-2 text-sm font-mono text-strong focus:outline-none focus:ring-2 focus:ring-accent/30" />
        </Field>
        <label className="flex items-start gap-2.5 text-sm text-default">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={requireMfa} onChange={e => setRequireMfa(e.target.checked)} />
          <span>
            Pedir verificación en dos pasos
            <span className="block text-xs text-muted mt-0.5">
              Quien no la tenga la configura al ingresar. Sin esto, alcanza la contraseña para quien no la usa.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-sm text-default">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={usageReports} onChange={e => setUsageReports(e.target.checked)} />
          <span>
            Reportes de consumo
            <span className="block text-xs text-muted mt-0.5">
              La aplicación puede pedir, por cada persona que ingresó, el reporte de su propio consumo y, si administra un
              equipo, el del equipo sumado, sin el detalle por persona. Cada pedido queda en Auditoría.
            </span>
          </span>
        </label>
        {error && <p role="alert" className="text-xs text-err">{error}</p>}
        <div className="flex gap-2 pt-1">
          <Btn variant="secondary" onClick={onClose} className="flex-1">Cancelar</Btn>
          <Btn onClick={submit} disabled={saving} className="flex-1">
            {saving ? 'Guardando…' : isEdit ? 'Guardar cambios' : 'Registrar aplicación'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

export default function AppsPage() {
  const { can } = usePermissions()
  const canManage = can('apps.manage')
  const [data, setData] = useState(null)
  const [modal, setModal] = useState(null)
  const [reveal, setReveal] = useState(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/apps')
    setData(res.ok ? await res.json() : { apps: [], issuer: null })
  }, [])
  useEffect(() => { load() }, [load])

  async function rotate(app) {
    if (!window.confirm(`¿Generar un secreto nuevo para ${app.name}? El actual deja de funcionar ya.`)) return
    const res = await fetch(`/api/apps/${app.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rotate-secret' }),
    })
    const d = await res.json()
    if (res.ok) setReveal({ app, secret: d.clientSecret })
    else window.alert(d.message ?? 'No se pudo generar.')
  }

  async function revoke(app) {
    if (!window.confirm(`¿Dar de baja ${app.name}? Nadie más podrá ingresar a ella con su cuenta.`)) return
    const res = await fetch(`/api/apps/${app.id}`, { method: 'DELETE' })
    if (!res.ok) window.alert((await res.json()).message ?? 'No se pudo dar de baja.')
    load()
  }

  function saved(d) {
    setModal(null)
    if (d.clientSecret) setReveal({ app: d.app, secret: d.clientSecret })
    load()
  }

  const action = 'min-h-[36px] px-2.5 rounded-md text-[13px] text-accent hover:bg-accent-light'

  return (
    <div className="px-4 py-6 md:px-10 md:py-8 max-w-screen-xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-[26px] font-semibold text-strong tracking-tight">Aplicaciones</h1>
          <p className="text-sm text-muted max-w-2xl">
            Aplicaciones propias donde las personas ingresan con su cuenta de Stratum (OpenID Connect), como un portal
            de chat. Pueden ingresar todas las personas activas, con equipo y con acceso a aplicaciones, también las que
            no usan la consola.
          </p>
        </div>
        {canManage && data?.issuer && <Btn onClick={() => setModal('create')}>+ Nueva aplicación</Btn>}
      </div>

      {data && !data.issuer && (
        <p role="status" className="text-sm text-warn bg-warn-light rounded-[10px] px-4 py-3">
          El ingreso a aplicaciones está apagado: definí <code className="font-mono">STRATUM_CONSOLE_URL</code> con la
          dirección pública de la consola (https).
        </p>
      )}
      {data?.issuer && (
        <div className="bg-card border border-border rounded-[10px] px-5 py-4 text-sm">
          <span className="text-muted">Configuración para las aplicaciones (discovery): </span>
          <code className="font-mono text-strong break-all select-all">{data.discovery}</code>
        </div>
      )}

      <div className="bg-card border border-border rounded-[10px] divide-y divide-border">
        {!data ? (
          <p className="px-5 py-8 text-sm text-muted">Cargando…</p>
        ) : data.apps.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted">Todavía no hay aplicaciones registradas.</p>
        ) : data.apps.map(app => (
          <div key={app.id} className={`px-5 py-4 flex flex-wrap items-start justify-between gap-3 ${app.revoked_at ? 'opacity-50' : ''}`}>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-strong">{app.name}</span>
                {app.require_mfa && <span className="text-xs text-default border border-border rounded px-2 py-0.5">2 pasos</span>}
                {app.usage_reports && <span className="text-xs text-default border border-border rounded px-2 py-0.5">reportes de consumo</span>}
                {app.revoked_at && <span className="text-xs text-warn">dada de baja</span>}
              </div>
              <div className="text-xs font-mono text-muted break-all">{app.id}</div>
              {app.redirect_uris.map(u => <div key={u} className="text-xs font-mono text-default break-all">{u}</div>)}
            </div>
            {canManage && !app.revoked_at && (
              <div className="flex flex-wrap items-center gap-1">
                <button type="button" onClick={() => setModal({ app })} className={action}>Editar</button>
                <button type="button" onClick={() => rotate(app)} className={action}>Nuevo secreto</button>
                <button type="button" onClick={() => revoke(app)} className={`${action} text-err hover:bg-err-light`}>Dar de baja</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {modal === 'create' && <AppModal onSave={saved} onClose={() => setModal(null)} />}
      {modal?.app && <AppModal app={modal.app} onSave={saved} onClose={() => setModal(null)} />}
      {reveal && <SecretReveal app={reveal.app} secret={reveal.secret} onClose={() => setReveal(null)} />}
    </div>
  )
}
