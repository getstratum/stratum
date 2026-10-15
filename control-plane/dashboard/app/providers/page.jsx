'use client'

import { useState, useEffect, useCallback } from 'react'
import Modal, { Field, Input, Select, Btn } from '../../components/Modal'

const API = '/api/internal/providers'

async function send(url, method, body) {
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, data }
}

function fmtDate(v) {
  return v ? new Date(v).toLocaleDateString('es-UY', { day: 'numeric', month: 'short' }) : ''
}

function TestResult({ result }) {
  if (!result) return null
  return (
    <p role="status" className={`text-xs rounded-lg px-3 py-2 ${result.ok ? 'text-ok bg-ok-light' : 'text-err bg-err-light'}`}>
      {result.message}
      {result.ok && result.models != null && ` ${result.models} modelos disponibles.`}
      {result.ms > 0 && ` (${result.ms} ms)`}
    </p>
  )
}

// ── Add (or replace) a provider ─────────────────────────────────────────────
function AddModal({ presets, existing, onClose, onSaved }) {
  const [form, setForm] = useState({ kind: 'anthropic', customName: '', displayName: '', baseUrl: '', apiVersion: '', apiKey: '' })
  const [error, setError]   = useState('')
  const [saving, setSaving] = useState(false)
  const [test, setTest]     = useState(null)
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setTest(null) }

  const custom   = form.kind === 'custom'
  const preset   = presets.find(p => p.id === form.kind)
  const provider = custom ? `custom-${form.customName.trim().toLowerCase()}` : form.kind
  const needsUrl = custom || !preset?.base
  const replaces = existing.find(p => p.provider === provider)
  const testable = !custom && preset?.base && !form.baseUrl && form.kind !== 'azure'

  function payload() {
    return {
      provider,
      display_name: form.displayName || undefined,
      base_url: form.baseUrl || undefined,
      api_key: form.apiKey || undefined,
      ...(form.kind === 'azure' ? { extra_config: { api_version: form.apiVersion } } : {}),
    }
  }

  async function runTest() {
    setTest({ ok: true, message: 'Probando…', ms: 0 })
    const { data } = await send(`${API}/test`, 'POST', { provider, api_key: form.apiKey })
    setTest(data.message ? data : { ok: false, message: 'No se pudo probar.', ms: 0 })
  }

  async function save() {
    setSaving(true); setError('')
    const { ok, data } = await send(API, 'POST', payload())
    setSaving(false)
    if (!ok) return setError(data.message ?? 'No se pudo guardar.')
    onSaved()
  }

  return (
    <Modal title="Agregar proveedor" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Proveedor">
          <Select value={form.kind} onChange={e => set('kind', e.target.value)}>
            {presets.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            <option value="custom">Custom (compatible con OpenAI)</option>
          </Select>
        </Field>
        {custom && (
          <Field label="Nombre corto" hint={`Los clientes lo usan como modelo "${provider}/<modelo>". Minúsculas, números y guiones.`}>
            <Input value={form.customName} onChange={e => set('customName', e.target.value)} placeholder="vllm-interno" />
          </Field>
        )}
        <Field label="Nombre visible">
          <Input value={form.displayName} onChange={e => set('displayName', e.target.value)} placeholder={custom ? 'vLLM interno' : preset?.label} />
        </Field>
        <Field
          label={needsUrl ? 'URL base' : 'URL base (opcional)'}
          hint={needsUrl
            ? 'La resuelven los gateways, no la consola: puede ser una dirección interna de tu red.'
            : `Por defecto ${preset?.base}. Cambiala solo para pasar por un proxy corporativo.`}
        >
          <Input value={form.baseUrl} onChange={e => set('baseUrl', e.target.value)} placeholder={needsUrl ? 'http://vllm.interno:8000' : preset?.base} />
        </Field>
        {form.kind === 'azure' && (
          <Field label="API version" hint="Por ejemplo 2024-10-21">
            <Input value={form.apiVersion} onChange={e => set('apiVersion', e.target.value)} placeholder="2024-10-21" />
          </Field>
        )}
        <Field label={preset?.keyRequired === false || custom ? 'API key (opcional)' : 'API key'} hint="Se guarda cifrada. Después solo vas a ver sus últimos 4 caracteres.">
          <Input type="password" autoComplete="off" value={form.apiKey} onChange={e => set('apiKey', e.target.value)} />
        </Field>

        {replaces && (
          <p className="text-xs text-warn bg-warn-light rounded-lg px-3 py-2">
            Ya hay una configuración de {replaces.provider_label}: guardar la reemplaza (los gateways usan una por proveedor).
          </p>
        )}
        <TestResult result={test} />
        {error && <p className="text-xs text-err bg-err-light rounded-lg px-3 py-2">{error}</p>}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {testable && <Btn variant="secondary" onClick={runTest} disabled={!form.apiKey}>Probar conexión</Btn>}
          <Btn variant="secondary" onClick={onClose}>Cancelar</Btn>
          <Btn onClick={save} disabled={saving || (custom && !form.customName.trim())}>
            {saving ? 'Guardando…' : replaces ? 'Reemplazar' : 'Guardar'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Edit name, address, credential ─────────────────────────────────────────
function EditModal({ provider, onClose, onSaved }) {
  const [form, setForm] = useState({
    displayName: provider.display_name, baseUrl: provider.base_url ?? '',
    apiVersion: provider.extra_config?.api_version ?? '', apiKey: '',
  })
  const [error, setError]   = useState('')
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function save() {
    const body = {}
    if (form.displayName !== provider.display_name) body.display_name = form.displayName
    if (form.baseUrl !== (provider.base_url ?? '')) body.base_url = form.baseUrl || null
    if (provider.provider === 'azure' && form.apiVersion !== (provider.extra_config?.api_version ?? '')) {
      body.extra_config = { api_version: form.apiVersion }
    }
    if (form.apiKey) body.api_key = form.apiKey
    if (!Object.keys(body).length) return onClose()
    setSaving(true); setError('')
    const { ok, data } = await send(`${API}?id=${provider.id}`, 'PATCH', body)
    setSaving(false)
    if (!ok) return setError(data.message ?? 'No se pudo guardar.')
    onSaved()
  }

  return (
    <Modal title={`Editar ${provider.display_name}`} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Nombre visible">
          <Input value={form.displayName} onChange={e => set('displayName', e.target.value)} />
        </Field>
        <Field label="URL base" hint={provider.default_base_url ? `Vacía = ${provider.default_base_url}` : 'Obligatoria para este proveedor.'}>
          <Input value={form.baseUrl} onChange={e => set('baseUrl', e.target.value)} placeholder={provider.default_base_url ?? ''} />
        </Field>
        {provider.provider === 'azure' && (
          <Field label="API version">
            <Input value={form.apiVersion} onChange={e => set('apiVersion', e.target.value)} />
          </Field>
        )}
        <Field label="Reemplazar la API key" hint={provider.api_key_hint ? `Actual: ${provider.api_key_hint}. Vacío = no cambia.` : 'Vacío = no cambia.'}>
          <Input type="password" autoComplete="off" value={form.apiKey} onChange={e => set('apiKey', e.target.value)} />
        </Field>
        {error && <p className="text-xs text-err bg-err-light rounded-lg px-3 py-2">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="secondary" onClick={onClose}>Cancelar</Btn>
          <Btn onClick={save} disabled={saving}>{saving ? 'Guardando…' : 'Guardar y publicar a gateways'}</Btn>
        </div>
      </div>
    </Modal>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function ProvidersPage() {
  const [providers, setProviders] = useState([])
  const [presets, setPresets]     = useState([])
  const [canManage, setCanManage] = useState(false)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')
  const [modal, setModal]         = useState(null)
  const [tests, setTests]         = useState({})

  const load = useCallback(async () => {
    const res = await fetch(API)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data.message ?? 'No se pudieron cargar los proveedores.'); setLoading(false); return }
    setProviders(data.providers); setPresets(data.presets); setLoading(false)
  }, [])

  useEffect(() => {
    load()
    fetch('/api/session').then(r => r.json()).then(me => setCanManage(me.permissions?.['providers.manage'] === 'org')).catch(() => {})
  }, [load])

  async function toggle(p) {
    const { ok, data } = await send(`${API}?id=${p.id}`, 'PATCH', { enabled: !p.enabled })
    if (!ok) window.alert(data.message ?? 'No se pudo cambiar.')
    load()
  }

  async function revoke(p) {
    if (!window.confirm(`¿Revocar ${p.display_name}? Los gateways dejan de usarlo en 30 s como máximo y la credencial se descarta.`)) return
    const { ok, data } = await send(`${API}?id=${p.id}`, 'DELETE')
    if (!ok) window.alert(data.message ?? 'No se pudo revocar.')
    load()
  }

  async function test(p) {
    setTests(t => ({ ...t, [p.id]: { ok: true, message: 'Probando…', ms: 0 } }))
    const { data } = await send(`${API}/test`, 'POST', { id: p.id })
    setTests(t => ({ ...t, [p.id]: data.message ? data : { ok: false, message: 'No se pudo probar.', ms: 0 } }))
  }

  const done = () => { setModal(null); load() }

  return (
    <div className="p-7 max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div className="max-w-2xl">
          <h1 className="text-lg font-semibold text-strong">Proveedores</h1>
          <p className="text-sm text-muted mt-1">
            Las credenciales se cifran en el control plane y llegan cifradas a los gateways, que las usan en 30 s como máximo.
            Nadie puede volver a verlas: solo reemplazarlas.
          </p>
        </div>
        {canManage && <Btn onClick={() => setModal({ add: true })}>Agregar proveedor</Btn>}
      </div>

      {error && <p className="text-sm text-err bg-err-light rounded-lg px-4 py-3 mb-4">{error}</p>}

      <div className="bg-card border border-border rounded-xl overflow-x-auto">
        {loading ? (
          <p className="p-6 text-sm text-muted">Cargando…</p>
        ) : providers.length === 0 ? (
          <div className="p-8 text-sm text-muted">
            Todavía no hay proveedores. {canManage ? 'Agregá uno para que los gateways puedan atender requests.' : ''}
          </div>
        ) : (
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted border-b border-border">
                <th className="px-5 py-3 font-semibold">Conexión</th>
                <th className="px-4 py-3 font-semibold">Credencial</th>
                <th className="px-4 py-3 font-semibold">Dirección</th>
                <th className="px-4 py-3 font-semibold">Estado</th>
                <th className="px-5 py-3"><span className="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              {providers.map(p => (
                <tr key={p.id} className="border-b border-border last:border-0 align-top">
                  <td className="px-5 py-3.5">
                    <div className="font-semibold text-strong">{p.display_name}</div>
                    <div className="text-xs text-muted">{p.provider_label} · modelo <code>{p.provider}/…</code></div>
                  </td>
                  <td className="px-4 py-3.5">
                    <code className="text-xs">{p.api_key_hint ?? (p.key_updated_at ? 'sin credencial' : 'configurada')}</code>
                    {p.key_updated_by && <div className="text-xs text-muted">{p.key_updated_by} · {fmtDate(p.key_updated_at)}</div>}
                  </td>
                  <td className="px-4 py-3.5 text-xs text-muted break-all">
                    {p.base_url ?? <span>por defecto</span>}
                  </td>
                  <td className="px-4 py-3.5">
                    <span className={`text-xs font-semibold ${p.enabled ? 'text-ok' : 'text-subtle'}`}>
                      {p.enabled ? '● Habilitado' : '○ Deshabilitado'}
                    </span>
                    {tests[p.id] && <div className="mt-2 max-w-xs"><TestResult result={tests[p.id]} /></div>}
                  </td>
                  <td className="px-5 py-3.5">
                    {canManage && (
                      <div className="flex flex-wrap justify-end gap-1">
                        {p.testable && (
                          <button onClick={() => test(p)} className="text-xs text-accent hover:text-accent-hover px-2 py-1 rounded hover:bg-raised">Probar</button>
                        )}
                        <button onClick={() => setModal({ edit: p })} className="text-xs text-muted hover:text-default px-2 py-1 rounded hover:bg-raised">Editar</button>
                        <button onClick={() => toggle(p)} className="text-xs text-muted hover:text-default px-2 py-1 rounded hover:bg-raised">
                          {p.enabled ? 'Deshabilitar' : 'Habilitar'}
                        </button>
                        <button onClick={() => revoke(p)} className="text-xs text-err px-2 py-1 rounded hover:bg-raised">Revocar</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-subtle mt-4 max-w-2xl">
        Los clientes eligen el proveedor con <code>"model": "proveedor/modelo"</code>, por ejemplo <code>anthropic/claude-haiku-4-5</code>.
        Con un solo proveedor configurado, el nombre del modelo alcanza.
      </p>

      {modal?.add && <AddModal presets={presets} existing={providers} onClose={() => setModal(null)} onSaved={done} />}
      {modal?.edit && <EditModal provider={modal.edit} onClose={() => setModal(null)} onSaved={done} />}
    </div>
  )
}
