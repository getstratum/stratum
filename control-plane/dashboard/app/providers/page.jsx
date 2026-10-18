'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import Modal, { Field, Input, Btn } from '../../components/Modal'
import { allowedBy } from '../../lib/catalog'

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

// ── Provider picker: search, category and free tier ───────────────────────
const CATEGORIES = [
  ['all', 'Todos'], ['lab', 'Laboratorios'], ['inference', 'Inferencia'], ['cloud', 'Nubes'],
  ['regional', 'Regionales'], ['router', 'Routers'], ['self', 'Propios'],
]
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES)
const hostOf = (url) => { try { return new URL(url).host } catch { return '' } }

function ProviderPicker({ presets, value, onChange }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [freeOnly, setFreeOnly] = useState(false)
  const q = query.trim().toLowerCase()
  const options = [
    ...presets,
    { id: 'custom', label: 'Custom (compatible con OpenAI)', category: 'self', free: false, base: null },
  ].filter(p => (category === 'all' || p.category === category) && (!freeOnly || p.free) &&
    (!q || p.label.toLowerCase().includes(q) || p.id.includes(q) || hostOf(p.base).includes(q)))
  // Counts follow the free-tier filter, so a chip never promises more than it shows.
  const pool = presets.filter(p => !freeOnly || p.free)
  const counts = Object.fromEntries(CATEGORIES.map(([c]) => [c,
    (c === 'all' ? pool.length : pool.filter(p => p.category === c).length) + (!freeOnly && (c === 'all' || c === 'self') ? 1 : 0)]))

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search" value={query} onChange={e => setQuery(e.target.value)} aria-label="Buscar proveedor"
          placeholder="Buscar proveedor…"
          className="flex-1 min-w-[12rem] h-9 px-3 rounded-md border border-border bg-card text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={freeOnly} onChange={e => setFreeOnly(e.target.checked)} /> Con plan gratis
        </label>
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Categoría">
        {CATEGORIES.map(([c, label]) => (
          <button
            key={c} type="button" onClick={() => setCategory(c)} aria-pressed={category === c}
            className={`text-xs px-2.5 py-1 rounded-full border ${category === c ? 'bg-ink text-white border-ink' : 'border-border text-muted hover:text-default'}`}
          >
            {label} <span className="tabular opacity-70">{counts[c]}</span>
          </button>
        ))}
      </div>
      <ul className="max-h-60 overflow-y-auto border border-border rounded-md divide-y divide-border" aria-label="Proveedores">
        {options.length === 0 && <li className="px-3 py-3 text-xs text-muted">Ninguno coincide.</li>}
        {options.map(p => (
          <li key={p.id}>
            <button
              type="button" onClick={() => onChange(p.id)} aria-pressed={value === p.id}
              className={`w-full text-left px-3 py-2 flex items-center justify-between gap-3 ${value === p.id ? 'bg-accent-light' : 'hover:bg-raised'}`}
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-strong truncate">{p.label}</span>
                <span className="block text-xs text-muted truncate">
                  {CATEGORY_LABEL[p.category]}{p.base ? ` · ${hostOf(p.base)}` : p.id === 'custom' ? ' · cualquier endpoint' : ' · dirección propia'}
                </span>
              </span>
              {p.free && <span className="shrink-0 text-[11px] font-semibold text-ok">Plan gratis</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
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
  const testable = !custom && preset?.testable && !form.baseUrl

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
          <ProviderPicker presets={presets} value={form.kind} onChange={v => set('kind', v)} />
        </Field>
        {preset && (preset.docs || preset.category === 'router') && (
          <div className="text-xs text-muted space-y-1">
            {preset.docs && (
              <p>
                <a href={preset.docs} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent-hover">
                  Conseguir una API key de {preset.label} ↗
                </a>
              </p>
            )}
            {preset.category === 'router' && (
              <p className="text-warn bg-warn-light rounded-lg px-3 py-2">
                Un router revende acceso a modelos de otros proveedores: los datos pasan también por él. Revisá sus términos antes de habilitarlo.
              </p>
            )}
          </div>
        )}
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
  const [catalog, setCatalog]     = useState([])
  const [policies, setPolicies]   = useState([])

  const load = useCallback(async () => {
    const res = await fetch(API)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data.message ?? 'No se pudieron cargar los proveedores.'); setLoading(false); return }
    setProviders(data.providers); setPresets(data.presets); setLoading(false)
    const [m, pol] = await Promise.all([
      fetch('/api/models').then(r => (r.ok ? r.json() : [])).catch(() => []),
      fetch('/api/policies').then(r => (r.ok ? r.json() : [])).catch(() => []),
    ])
    setCatalog(Array.isArray(m) ? m : []); setPolicies(Array.isArray(pol) ? pol : [])
  }, [])

  // Catalog models of a provider, and how many of them some policy allows.
  function modelsOf(provider) {
    const list = catalog.filter(m => m.provider === provider)
    return { total: list.length, allowed: list.filter(m => policies.some(pol => allowedBy(pol, m))).length }
  }

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
    <div className="px-4 py-6 md:px-10 md:py-8 max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div className="max-w-2xl">
          <h1 className="text-[26px] font-semibold text-strong tracking-tight">Proveedores</h1>
          <p className="text-sm text-muted mt-1">
            Las credenciales se cifran en el control plane y llegan cifradas a los gateways, que las usan en 30 s como máximo.
            Nadie puede volver a verlas: solo reemplazarlas.
          </p>
        </div>
        {canManage && <Btn onClick={() => setModal({ add: true })}>Agregar proveedor</Btn>}
      </div>

      {error && <p className="text-sm text-err bg-err-light rounded-lg px-4 py-3 mb-4">{error}</p>}

      <div className="relative bg-card border border-border rounded-[10px] overflow-x-auto">
        {loading ? (
          <p className="p-6 text-sm text-muted">Cargando…</p>
        ) : providers.length === 0 ? (
          <div className="p-8 text-sm text-muted">
            Todavía no hay proveedores. {canManage ? 'Agregá uno para que los gateways puedan atender requests.' : ''}
          </div>
        ) : (
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted border-b border-border">
                <th className="px-5 py-3 font-semibold">Conexión</th>
                <th className="px-4 py-3 font-semibold">Credencial</th>
                <th className="px-4 py-3 font-semibold">Dirección</th>
                <th className="px-4 py-3 font-semibold">Modelos</th>
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
                  <td className="px-4 py-3.5 text-xs">
                    {(() => {
                      const n = modelsOf(p.provider)
                      return n.total === 0 ? (
                        <span className="text-muted">Fuera del catálogo: sin precios</span>
                      ) : (
                        <div className="space-y-0.5">
                          <div className="text-strong tabular">{n.total} en el catálogo</div>
                          <div className="text-muted tabular">{n.allowed} permitidos por alguna política</div>
                          <Link href={`/models?provider=${encodeURIComponent(p.provider)}`} className="text-accent hover:text-accent-hover">Ver modelos</Link>
                        </div>
                      )
                    })()}
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
