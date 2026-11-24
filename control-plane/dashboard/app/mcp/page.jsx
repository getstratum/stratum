'use client'
// Herramientas MCP (lib/mcp.js, ADR-0016): the MCP servers agents reach
// through the gateway at /mcp/<name>, with the credential kept here. Which
// tools each team may call is in its policy.

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import Modal, { Field, Input, Btn } from '../../components/Modal'
import { usePermissions } from '../../components/usePermissions'

const ago = (t) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(t)) / 60_000))
  return m < 1 ? 'recién' : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} días`
}

// What the server offers, as a gateway listed it (tools/list; the console
// never calls the servers). "Solo lee" is what the server says: a hint.
function Tools({ s }) {
  if (!s.tools_at) return <div className="text-xs text-subtle mt-1">Ningún gateway informó sus herramientas todavía.</div>
  if (s.tools_error) return <div className="text-xs text-warn mt-1" data-testid="mcp-tools-error">No se pudieron listar sus herramientas ({ago(s.tools_at)}): {s.tools_error}</div>
  const tools = s.tools ?? []
  return (
    <details className="text-xs mt-1" data-testid="mcp-tools">
      <summary className="cursor-pointer text-muted">{tools.length === 1 ? '1 herramienta' : `${tools.length} herramientas`} · vistas {ago(s.tools_at)}</summary>
      <ul className="mt-1 flex flex-col gap-0.5">
        {tools.map(t => (
          <li key={t.name}>
            <span className="font-mono text-strong">{t.name}</span>
            {t.read_only && <span className="ml-1 text-subtle">· el servidor dice que solo lee</span>}
            {t.description && <span className="text-muted"> — {t.description}</span>}
          </li>
        ))}
      </ul>
    </details>
  )
}

function ServerModal({ server, onClose, onSaved }) {
  const editing = Boolean(server)
  const [form, setForm] = useState({
    name: server?.name ?? '',
    description: server?.description ?? '',
    url: server?.url ?? '',
    authHeader: server?.auth_header ?? 'Authorization',
    secret: '',
    enabled: server?.enabled ?? true,
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function save() {
    setSaving(true); setError('')
    const body = { description: form.description, url: form.url, enabled: form.enabled }
    if (!editing) body.name = form.name
    // A value typed now replaces the kept one; empty, the kept one stays
    // (under another header, if that changed).
    if (form.secret) Object.assign(body, { authHeader: form.authHeader, secret: form.secret })
    else if (editing && server.secret_hint && form.authHeader !== server.auth_header) body.authHeader = form.authHeader
    const res = await fetch(editing ? `/api/mcp-servers/${server.id}` : '/api/mcp-servers', {
      method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) return setError(data.message ?? 'No se pudo guardar.')
    onSaved()
  }

  async function forget() {
    setSaving(true); setError('')
    const res = await fetch(`/api/mcp-servers/${server.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: null, authHeader: null }),
    })
    const data = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) return setError(data.message ?? 'No se pudo guardar.')
    onSaved()
  }

  return (
    <Modal title={editing ? `Servidor MCP ${server.name}` : 'Nuevo servidor MCP'} onClose={onClose} width="max-w-xl">
      <div className="space-y-4">
        {!editing && (
          <Field label="Nombre" hint="Los agentes lo usan en la dirección /mcp/nombre del gateway. Minúsculas, números y guiones; no cambia después.">
            <Input id="mcp-name" value={form.name} onChange={e => set('name', e.target.value.toLowerCase())} placeholder="tickets" autoFocus />
          </Field>
        )}
        <Field label="Para qué es" hint="Opcional.">
          <Input id="mcp-description" value={form.description} onChange={e => set('description', e.target.value)} placeholder="Crear y buscar tickets de soporte" />
        </Field>
        <Field label="URL" hint="El endpoint Streamable HTTP del servidor, como lo alcanza el gateway desde tu red. La consola nunca lo llama.">
          <Input id="mcp-url" value={form.url} onChange={e => set('url', e.target.value)} placeholder="https://mcp.tickets.interno/mcp" />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Encabezado" hint="Donde va la credencial.">
            <Input id="mcp-header" value={form.authHeader} onChange={e => set('authHeader', e.target.value)} placeholder="Authorization" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Valor" hint={editing && server.secret_hint
              ? `Guardado: ${server.secret_hint}. Vacío: queda el guardado.`
              : 'Opcional. Se guarda cifrado y solo lo usa el gateway; los agentes nunca lo ven.'}>
              <Input id="mcp-secret" type="password" autoComplete="off" value={form.secret} onChange={e => set('secret', e.target.value)} placeholder="Bearer …" />
            </Field>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-default">
          <input type="checkbox" className="accent-accent" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} />
          Encendido: los gateways lo sirven
        </label>
        {error && <p role="alert" className="text-xs text-err bg-err-light rounded-lg px-3 py-2">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {editing && server.secret_hint && <Btn variant="secondary" disabled={saving} onClick={forget}>Quitar la credencial</Btn>}
          <Btn variant="secondary" onClick={onClose}>Cancelar</Btn>
          <Btn disabled={saving || !form.url || (!editing && !form.name)} onClick={save}>{saving ? 'Guardando…' : 'Guardar'}</Btn>
        </div>
      </div>
    </Modal>
  )
}

export default function McpPage() {
  const { can } = usePermissions()
  const canManage = can('providers.manage')
  const [servers, setServers] = useState(null)
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const res = await fetch('/api/mcp-servers').catch(() => null)
    const data = res?.ok ? await res.json() : { servers: [] }
    setServers(data.servers)
  }, [])
  useEffect(() => { load() }, [load])

  async function toggle(s) {
    await fetch(`/api/mcp-servers/${s.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !s.enabled }),
    }).catch(() => {})
    load()
  }
  async function remove(s) {
    setError('')
    const res = await fetch(`/api/mcp-servers/${s.id}`, { method: 'DELETE' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return setError(data.message ?? 'No se pudo borrar.')
    load()
  }

  return (
    <div className="px-4 py-6 md:px-10 md:py-8 max-w-screen-xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1 max-w-3xl">
          <h1 className="text-[26px] font-semibold text-strong tracking-tight">Herramientas MCP</h1>
          <p className="text-sm text-muted">
            Los servidores MCP que los agentes usan a través del gateway, en <code className="font-mono text-default">/mcp/nombre</code>,
            con su propia key de Stratum. La credencial de cada servidor queda acá: los agentes no la ven. Qué herramientas puede
            llamar cada equipo lo dice su <Link href="/policy" className="text-accent hover:text-accent-hover">política</Link>; sin
            herramientas en la política, ninguna. Cada llamada queda en Requests, también las rechazadas y los intentos de un equipo que no puede usar el servidor.
          </p>
        </div>
        {canManage && <Btn onClick={() => setEditing({})}>+ Nuevo servidor</Btn>}
      </header>
      {error && <p role="alert" className="text-sm text-err bg-err-light rounded-lg px-3 py-2">{error}</p>}

      <section className="bg-card border border-border rounded-[10px] overflow-x-auto" data-testid="mcp-servers">
        {servers === null ? (
          <p className="p-6 text-sm text-muted">Cargando…</p>
        ) : servers.length === 0 ? (
          <p className="p-6 text-sm text-muted">Todavía no hay servidores MCP.</p>
        ) : (
          <table className="stack w-full min-w-[860px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted border-b border-border">
                <th className="px-5 py-3 font-semibold">Servidor</th>
                <th className="px-3 py-3 font-semibold">URL</th>
                <th className="px-3 py-3 font-semibold">Credencial</th>
                <th className="px-3 py-3 font-semibold">Permitido en</th>
                <th className="px-5 py-3 font-semibold">Estado</th>
              </tr>
            </thead>
            <tbody>
              {servers.map(s => (
                <tr key={s.id} className="border-b border-border last:border-0 align-top" data-testid="mcp-server">
                  <td className="px-5 py-3">
                    <div className="font-mono text-strong">/mcp/{s.name}</div>
                    {s.description && <div className="text-xs text-muted">{s.description}</div>}
                    <Tools s={s} />
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-default break-all max-w-[280px]">{s.url}</td>
                  <td className="px-3 py-3 text-xs">
                    {s.secret_hint ? <span className="font-mono text-default">{s.auth_header}: {s.secret_hint}</span> : <span className="text-muted">Sin credencial</span>}
                  </td>
                  <td className="px-3 py-3 text-xs">
                    {s.policies.length ? s.policies.join(', ') : <span className="text-muted">Ninguna política</span>}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap items-center gap-1">
                      {canManage ? (
                        <>
                          <button type="button" role="switch" aria-checked={s.enabled} aria-label={`${s.name} encendido`} onClick={() => toggle(s)}
                                  className={`text-xs font-semibold px-2 py-1 rounded ${s.enabled ? 'text-ok hover:bg-raised' : 'text-subtle hover:bg-raised'}`}>
                            {s.enabled ? '● Encendido' : '○ Apagado'}
                          </button>
                          <button type="button" onClick={() => setEditing(s)} className="text-xs text-accent hover:text-accent-hover px-2 py-1 rounded hover:bg-raised">Editar</button>
                          <button type="button" onClick={() => remove(s)} aria-label={`Borrar ${s.name}`} className="text-xs text-err px-2 py-1 rounded hover:bg-err-light">Borrar</button>
                        </>
                      ) : (
                        <span className={`text-xs font-semibold ${s.enabled ? 'text-ok' : 'text-subtle'}`}>{s.enabled ? '● Encendido' : '○ Apagado'}</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="text-xs text-muted max-w-3xl">
        Un agente se conecta como a cualquier servidor MCP por HTTP: la dirección del gateway más <code className="font-mono">/mcp/nombre</code>,
        y su key de Stratum en <code className="font-mono">Authorization: Bearer</code>. El gateway le muestra solo las herramientas que su
        política permite y rechaza las demás con un resultado que el modelo puede leer. Gateways 0.7 o posterior.
      </p>

      {editing && (
        <ServerModal server={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />
      )}
    </div>
  )
}
