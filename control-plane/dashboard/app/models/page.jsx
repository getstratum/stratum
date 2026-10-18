'use client'

import Link from 'next/link'
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { usePermissions } from '../../components/usePermissions'
import Modal, { Field, Input, Btn } from '../../components/Modal'
import { allowedBy } from '../../lib/catalog'

const perMillion = v => {
  const n = parseFloat(v) * 1000
  return v != null && Number.isFinite(n) ? n.toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'
}
const fmtDate = v => (v ? new Date(v).toLocaleDateString('es-UY', { day: 'numeric', month: 'short', year: 'numeric' }) : '')

// The price an organization pays: its own when it set one, the list price otherwise.
function Price({ list, own }) {
  if (own == null) return <span>{perMillion(list)}</span>
  return (
    <span title={list != null ? `Lista: ${perMillion(list)}` : 'Sin precio de lista'}>
      <span className="font-semibold text-strong">{perMillion(own)}</span>
      {list != null && <span className="block text-xs text-muted line-through">{perMillion(list)}</span>}
    </span>
  )
}

function PriceModal({ model, onClose, onSaved }) {
  const toM = v => (v == null ? '' : String(Math.round(parseFloat(v) * 1000 * 1e6) / 1e6))
  const [input, setInput] = useState(toM(model.org_cost_per_1k_input_tokens))
  const [output, setOutput] = useState(toM(model.org_cost_per_1k_output_tokens))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function save(values) {
    setSaving(true); setError('')
    const res = await fetch('/api/models', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: model.provider, model_id: model.model_id, ...values }),
    })
    const data = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) return setError(data.message ?? 'No se pudo guardar.')
    onSaved()
  }
  const num = v => (v.trim() === '' ? null : Number(v.replace(',', '.')))

  return (
    <Modal title={`Precio de ${model.display_name}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Lo que paga tu organización, si negoció otro precio. Los requests nuevos se cuestan con él; los ya registrados no cambian.
          {model.source === 'provider' && ' Este modelo no está en el catálogo: sin un precio, su costo se registra como 0.'}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Entrada (US$ por millón)" hint={model.cost_per_1k_input_tokens != null ? `Lista: ${perMillion(model.cost_per_1k_input_tokens)}` : 'Sin precio de lista'}>
            <Input inputMode="decimal" value={input} onChange={e => setInput(e.target.value)} />
          </Field>
          <Field label="Salida (US$ por millón)" hint={model.cost_per_1k_output_tokens != null ? `Lista: ${perMillion(model.cost_per_1k_output_tokens)}` : 'Sin precio de lista'}>
            <Input inputMode="decimal" value={output} onChange={e => setOutput(e.target.value)} />
          </Field>
        </div>
        {error && <p className="text-xs text-err bg-err-light rounded-lg px-3 py-2">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {(model.org_cost_per_1k_input_tokens != null || model.org_cost_per_1k_output_tokens != null) && (
            <Btn variant="secondary" disabled={saving} onClick={() => save({ input_per_mtok: null, output_per_mtok: null })}>Volver al de lista</Btn>
          )}
          <Btn variant="secondary" onClick={onClose}>Cancelar</Btn>
          <Btn disabled={saving} onClick={() => save({ input_per_mtok: num(input), output_per_mtok: num(output) })}>{saving ? 'Guardando…' : 'Guardar'}</Btn>
        </div>
      </div>
    </Modal>
  )
}

function Badge({ tone, children }) {
  const tones = {
    ok:   'bg-ok-light text-ok',
    warn: 'bg-warn-light text-warn',
    err:  'bg-err-light text-err',
    info: 'bg-accent-light text-accent',
    none: 'bg-nav text-default',
  }
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${tones[tone]}`}>{children}</span>
}

function Models() {
  const params = useSearchParams()
  const { can } = usePermissions()
  const [catalog, setCatalog]       = useState([])
  const [policies, setPolicies]     = useState([])
  const [configured, setConfigured] = useState(null) // null: this role cannot list providers
  const [loading, setLoading]       = useState(true)
  const [filter, setFilter]         = useState('all')
  const [query, setQuery]           = useState('')
  const [checks, setChecks]         = useState({}) // provider → result of the connection test
  const [feed, setFeed]             = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [pricing, setPricing]       = useState(null)
  const [busy, setBusy]             = useState('')

  const load = useCallback(async () => {
    const [m, pol, prov, cat] = await Promise.all([
      fetch('/api/models').then(r => (r.ok ? r.json() : [])).catch(() => []),
      fetch('/api/policies').then(r => (r.ok ? r.json() : [])).catch(() => []),
      fetch('/api/internal/providers').then(r => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/models/catalog').then(r => (r.ok ? r.json() : null)).catch(() => null),
    ])
    setCatalog(Array.isArray(m) ? m : [])
    setFeed(cat)
    setPolicies(Array.isArray(pol) ? pol : [])
    setConfigured(prov ? prov.providers.filter(p => p.enabled) : null)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  // ?provider= follows the address, also when arriving from another link.
  useEffect(() => { setFilter(params.get('provider') || 'all') }, [params])

  const providers = useMemo(() => [...new Set(catalog.map(m => m.provider))].sort(), [catalog])
  const connected = id => configured?.find(c => c.provider === id)

  async function verify(conn) {
    setChecks(c => ({ ...c, [conn.provider]: { pending: true } }))
    const res = await fetch('/api/internal/providers/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: conn.id }),
    })
    const data = await res.json().catch(() => ({}))
    setChecks(c => ({ ...c, [conn.provider]: data }))
    if (data.ok) load() // the models it listed outside the catalog now appear
  }

  async function refreshFeed() {
    setRefreshing(true)
    const res = await fetch('/api/models/catalog', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    setRefreshing(false)
    if (data.state) setFeed(data.state)
    load()
  }

  async function toggle(m) {
    setBusy(`${m.provider}/${m.model_id}`)
    await fetch('/api/models', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: m.provider, model_id: m.model_id, enabled: !m.enabled }),
    }).catch(() => {})
    setBusy('')
    load()
  }

  const rows = catalog
    .filter(m => filter === 'all' || m.provider === filter)
    .filter(m => {
      const q = query.trim().toLowerCase()
      return !q || [m.model_id, m.display_name, ...(m.aliases ?? [])].some(s => s.toLowerCase().includes(q))
    })

  function status(m) {
    if (configured && !connected(m.provider)) return <Badge tone="none">Proveedor sin conectar</Badge>
    if (m.source === 'provider') return <Badge tone="ok">En tu cuenta</Badge>
    const check = checks[m.provider]
    if (!check?.ids) return <Badge tone="none">Sin verificar</Badge>
    const ids = new Set(check.ids)
    return [m.model_id, ...(m.aliases ?? [])].some(id => ids.has(id))
      ? <Badge tone="ok">En tu cuenta</Badge>
      : <Badge tone="warn">No está en tu cuenta</Badge>
  }

  const chip = (id, label) => (
    <button
      key={id}
      type="button"
      onClick={() => setFilter(id)}
      aria-pressed={filter === id}
      className={`min-h-[36px] px-3 rounded-full text-[13px] border ${
        filter === id ? 'bg-ink border-ink text-white' : 'bg-card border-border-strong text-strong hover:bg-raised'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="px-4 py-6 md:px-10 md:py-8 max-w-screen-xl space-y-5">
      <header className="space-y-1 max-w-3xl">
        <h1 className="text-[26px] font-semibold text-strong tracking-tight">Modelos</h1>
        <p className="text-sm text-muted">
          El catálogo, con precios de lista para estimar costos. Un pedido puede usar el ID de un modelo o cualquiera de
          sus alias. Qué modelos puede usar cada equipo lo decide su <Link href="/policy" className="text-accent hover:text-accent-hover">política</Link>;
          un modelo apagado acá no lo puede usar nadie de la organización.
        </p>
        {feed && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted pt-1">
            {!feed.feed_url ? (
              <span>Catálogo sin actualización automática (STRATUM_MODEL_CATALOG_URL=off).</span>
            ) : feed.applied_at ? (
              <span>Catálogo del {fmtDate(`${feed.feed_updated}T12:00:00`)}, revisado el {fmtDate(feed.checked_at)}.</span>
            ) : (
              <span>El catálogo todavía no se revisó.</span>
            )}
            {feed.error && <span className="text-err">No se pudo revisar ({feed.error}); sigue el catálogo anterior.</span>}
            {feed.feed_url && can('models.manage') && (
              <button type="button" onClick={refreshFeed} disabled={refreshing} className="text-accent hover:text-accent-hover disabled:opacity-50">
                {refreshing ? 'Revisando…' : 'Revisar ahora'}
              </button>
            )}
          </div>
        )}
      </header>

      {configured && configured.length > 0 && can('providers.manage') && (
        <section aria-labelledby="verify" className="bg-card border border-border rounded-[10px] px-5 py-4 space-y-3">
          <div className="space-y-1">
            <h2 id="verify" className="text-sm font-semibold text-strong">Verificar con el proveedor</h2>
            <p className="text-sm text-muted">
              Consulta la lista de modelos de tu cuenta con la credencial guardada. Solo para proveedores en su dirección
              por defecto: los demás se prueban desde un gateway.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {configured.map(c => (
              <button
                key={c.id}
                type="button"
                onClick={() => verify(c)}
                disabled={!c.testable || checks[c.provider]?.pending}
                title={c.testable ? undefined : 'Con una dirección propia se prueba desde un gateway'}
                className="min-h-[40px] px-3 rounded-md border border-border-strong bg-card text-sm text-strong hover:bg-raised disabled:opacity-50"
              >
                {checks[c.provider]?.pending ? `Consultando ${c.display_name}…` : c.display_name}
              </button>
            ))}
          </div>
          {Object.entries(checks).filter(([, c]) => c && !c.pending && !c.ok).map(([p, c]) => (
            <p key={p} role="status" className="text-xs text-err bg-err-light rounded-md px-3 py-2">{p}: {c.message}</p>
          ))}
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2.5">
        <label htmlFor="model-search" className="sr-only">Buscar modelo</label>
        <input
          id="model-search"
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Buscar modelo"
          className="flex-1 basis-56 max-w-xs h-10 px-3 rounded-md border border-border-strong bg-card text-sm text-strong placeholder-subtle"
        />
        <div role="group" aria-label="Proveedor" className="flex flex-wrap gap-1.5">
          {chip('all', 'Todos')}
          {providers.map(p => chip(p, p))}
        </div>
      </div>

      <section className="bg-card border border-border rounded-[10px] overflow-x-auto">
        {loading ? (
          <p className="p-6 text-sm text-muted">Cargando…</p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-muted">Ningún modelo coincide.</p>
        ) : (
          <table className="w-full min-w-[1080px] text-sm tabular">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted border-b border-border">
                <th className="px-5 py-3 font-semibold">Modelo</th>
                <th className="px-3 py-3 font-semibold">Proveedor</th>
                <th className="px-3 py-3 font-semibold text-right">Entrada US$/M</th>
                <th className="px-3 py-3 font-semibold text-right">Salida US$/M</th>
                <th className="px-3 py-3 font-semibold">Estado</th>
                <th className="px-3 py-3 font-semibold">Permitido en</th>
                <th className="px-5 py-3 font-semibold">En tu organización</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(m => {
                const allowing = policies.filter(p => allowedBy(p, m))
                return (
                  <tr key={`${m.provider}/${m.model_id}`} className="border-b border-border last:border-0 align-top">
                    <td className="px-5 py-3">
                      <div className="font-medium text-strong">{m.display_name}</div>
                      <div className="font-mono text-xs text-default">{m.model_id}</div>
                      {(m.aliases ?? []).length > 0 && (
                        <div className="text-xs text-muted">también <span className="font-mono">{m.aliases.join(', ')}</span></div>
                      )}
                      <div className="flex flex-wrap gap-1 mt-1">
                        {m.source === 'provider' && <Badge tone="info">Fuera del catálogo</Badge>}
                        {m.deprecated_on && <Badge tone="warn">Se retira el {fmtDate(m.deprecated_on)}</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-3">{m.provider}</td>
                    <td className="px-3 py-3 text-right"><Price list={m.cost_per_1k_input_tokens} own={m.org_cost_per_1k_input_tokens} /></td>
                    <td className="px-3 py-3 text-right"><Price list={m.cost_per_1k_output_tokens} own={m.org_cost_per_1k_output_tokens} /></td>
                    <td className="px-3 py-3">{status(m)}</td>
                    <td className="px-3 py-3" title={allowing.map(p => p.name).join(', ') || undefined}>
                      {m.enabled === false
                        ? <span className="text-muted">Nadie: está apagado</span>
                        : allowing.length === 0
                          ? <span className="text-muted">Ninguna política</span>
                          : allowing.length === 1 ? allowing[0].name : `${allowing.length} políticas`}
                    </td>
                    <td className="px-5 py-3">
                      {can('models.manage') ? (
                        <div className="flex flex-wrap items-center gap-1">
                          <button
                            type="button" role="switch" aria-checked={m.enabled !== false}
                            aria-label={`${m.display_name} en tu organización`}
                            onClick={() => toggle(m)} disabled={busy === `${m.provider}/${m.model_id}`}
                            className={`text-xs font-semibold px-2 py-1 rounded ${m.enabled !== false ? 'text-ok hover:bg-raised' : 'text-subtle hover:bg-raised'}`}
                          >
                            {m.enabled !== false ? '● Encendido' : '○ Apagado'}
                          </button>
                          <button type="button" onClick={() => setPricing(m)} className="text-xs text-accent hover:text-accent-hover px-2 py-1 rounded hover:bg-raised">
                            Precio
                          </button>
                        </div>
                      ) : (
                        <span className={`text-xs font-semibold ${m.enabled !== false ? 'text-ok' : 'text-subtle'}`}>
                          {m.enabled !== false ? '● Encendido' : '○ Apagado'}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      {pricing && <PriceModal model={pricing} onClose={() => setPricing(null)} onSaved={() => { setPricing(null); load() }} />}

      <p className="text-xs text-muted max-w-3xl">
        Un precio en negrita es el que negoció tu organización (tachado, el de lista).
        Precios de lista por millón de tokens (entrada y salida, tramo más corto cuando el precio depende del largo del
        prompt). El costo es una estimación: tokens que informa el proveedor × precio vigente al registrar el request; no
        incluye impuestos, créditos ni descuentos.
      </p>
    </div>
  )
}

export default function ModelsPage() {
  return (
    <Suspense fallback={<p className="px-4 py-6 md:px-10 md:py-8 text-sm text-muted">Cargando…</p>}>
      <Models />
    </Suspense>
  )
}
