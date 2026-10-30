'use client'

// Signing in with the organization's identity provider (lib/sso.js):
// Google Workspace, or any OpenID Connect provider (Microsoft Entra ID,
// Okta...). Only Owners change it; Admins and Auditors see it.

import { useCallback, useEffect, useState } from 'react'
import { Field, Input, Btn } from '../../components/Modal'
import { usePermissions } from '../../components/usePermissions'

const KINDS = [
  { id: 'google', label: 'Google Workspace' },
  { id: 'oidc', label: 'Otro proveedor (OpenID Connect)' },
]

export default function SsoPage() {
  const { can, ready } = usePermissions()
  const canManage = can('sso.manage')
  const [data, setData] = useState(null)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    const res = await fetch('/api/sso')
    const d = res.ok ? await res.json() : { provider: null, callbackUrl: null }
    setData(d)
    const p = d.provider
    setForm({
      kind: p?.kind ?? 'google', issuer: p?.kind === 'oidc' ? p.issuer : '', clientId: p?.clientId ?? '',
      clientSecret: '', domains: (p?.domains ?? []).join(', '), enforce: p?.enforce ?? false, enabled: p?.enabled ?? true,
    })
  }, [])
  useEffect(() => { load() }, [load])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function save() {
    setSaving(true); setError(''); setNotice('')
    try {
      const res = await fetch('/api/sso', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: form.kind, issuer: form.kind === 'oidc' ? form.issuer : undefined, clientId: form.clientId,
          clientSecret: form.clientSecret || undefined,
          domains: form.domains.split(/[\s,]+/).map(s => s.trim()).filter(Boolean),
          enforce: form.enforce, enabled: form.enabled,
        }),
      })
      const d = await res.json()
      if (!res.ok) { setError(d.message ?? 'No se pudo guardar.'); return }
      setNotice('Guardado. Probalo desde otra ventana antes de exigirlo.')
      await load()
    } catch { setError('No se pudo conectar con la consola.') }
    finally { setSaving(false) }
  }

  async function remove() {
    if (!window.confirm('¿Quitar el ingreso con SSO? Todas las personas vuelven a entrar con su contraseña.')) return
    await fetch('/api/sso', { method: 'DELETE' })
    setNotice('Quitado.')
    await load()
  }

  if (!data || !form || !ready) return <div className="px-4 py-6 md:px-10 md:py-8 text-sm text-muted">Cargando…</div>
  const p = data.provider

  return (
    <div className="px-4 py-6 md:px-10 md:py-8 max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-[26px] font-semibold text-strong tracking-tight">Ingreso con SSO</h1>
        <p className="text-sm text-muted">
          Las personas entran a la consola y a las aplicaciones (como el portal de chat) con la cuenta de la
          organización. Solo entra quien ya está en Usuarios con ese mail: nadie se crea al ingresar. El segundo
          factor es el del proveedor: exigilo ahí (en Google Workspace, la verificación en 2 pasos).
        </p>
      </div>

      {!data.callbackUrl ? (
        <p role="status" className="text-sm text-warn bg-warn-light rounded-[10px] px-4 py-3">
          Falta la dirección pública de la consola: definí <code className="font-mono">STRATUM_CONSOLE_URL</code> (https).
        </p>
      ) : (
        <div className="bg-card border border-border rounded-[10px] px-5 py-4 text-sm space-y-1">
          <div className="text-muted">Dirección de retorno, para registrar en el proveedor:</div>
          <code className="font-mono text-strong break-all select-all" data-testid="sso-callback">{data.callbackUrl}</code>
        </div>
      )}

      {p && (
        <p className="text-sm" data-testid="sso-state">
          {p.enabled ? 'Activo' : 'Apagado'} para {p.domains.join(', ')}
          {p.enforce ? ', y la contraseña ya no sirve (salvo para los Owners).' : '; la contraseña sigue sirviendo.'}
        </p>
      )}

      <fieldset disabled={!canManage || saving} className="bg-card border border-border rounded-[10px] p-5 space-y-4">
        <Field label="Proveedor">
          <select value={form.kind} onChange={e => set('kind', e.target.value)}
            className="w-full h-10 bg-raised border border-border rounded-md px-3 text-sm text-strong">
            {KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </Field>
        {form.kind === 'google' ? (
          <p className="text-xs text-muted">
            En Google Cloud (un proyecto de tu organización): APIs y servicios → Pantalla de consentimiento (tipo
            Interno) → Credenciales → ID de cliente de OAuth, tipo Aplicación web, con la dirección de retorno de
            arriba. Solo entran cuentas de Google Workspace de los dominios de abajo.
          </p>
        ) : (
          <Field label="Emisor (issuer)" hint="Su configuración tiene que estar en <emisor>/.well-known/openid-configuration.">
            <Input value={form.issuer} onChange={e => set('issuer', e.target.value)}
              placeholder="https://login.microsoftonline.com/<tenant>/v2.0" />
          </Field>
        )}
        <Field label="Client ID">
          <Input value={form.clientId} onChange={e => set('clientId', e.target.value)} />
        </Field>
        <Field label="Client secret" hint={p ? `Guardado (${p.clientSecretHint}). Dejalo vacío para no cambiarlo.` : 'Se guarda cifrado.'}>
          <Input type="password" value={form.clientSecret} onChange={e => set('clientSecret', e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Dominios" hint="Los del mail de las personas, separados por comas: acme.com, acme.com.uy">
          <Input value={form.domains} onChange={e => set('domains', e.target.value)} placeholder="acme.com" />
        </Field>
        <label className="flex items-start gap-2.5 text-sm text-default">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} />
          <span>Activo</span>
        </label>
        <label className="flex items-start gap-2.5 text-sm text-default">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={form.enforce} onChange={e => set('enforce', e.target.checked)} />
          <span>
            Exigir SSO
            <span className="block text-xs text-muted mt-0.5">
              La contraseña deja de servir para esos dominios, en la consola y en las aplicaciones. Los Owners la
              conservan, con su segundo factor, para entrar si el proveedor falla.
            </span>
          </span>
        </label>
        {error && <p role="alert" className="text-xs text-err">{error}</p>}
        {notice && <p role="status" className="text-xs text-muted">{notice}</p>}
        {canManage && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Btn onClick={save} disabled={saving}>{saving ? 'Guardando…' : 'Guardar'}</Btn>
            {p && <Btn variant="secondary" onClick={remove}>Quitar</Btn>}
          </div>
        )}
      </fieldset>
    </div>
  )
}
