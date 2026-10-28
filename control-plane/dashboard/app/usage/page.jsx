'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { co2, energy, water, middle, METHOD_URL } from '../../lib/impacts/format'

// Categorical slots in fixed order (validated: adjacent CVD ΔE ≥ 9.1 on the
// light surface). Three are under 3:1 on white, so the table below always
// carries the same numbers. "Otros" is a neutral, never a sixth hue.
const SLOTS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4']
const OTHER = '#9aa3b0'
const OTHER_KEY = '__otros'

const DIMS = [
  { id: 'team',     label: 'Equipos',     one: 'Equipo' },
  { id: 'agent',    label: 'Agentes',     one: 'Agente' },
  { id: 'user',     label: 'Personas',    one: 'Persona' },
  { id: 'model',    label: 'Modelos',     one: 'Modelo' },
  { id: 'provider', label: 'Proveedores', one: 'Proveedor' },
  { id: 'label',    label: 'Etiquetas',   one: 'Etiqueta' },
]
const dimOf = id => DIMS.find(d => d.id === id)
// Clicking a row narrows to it and groups by the next useful dimension.
const NEXT = { team: 'agent', agent: 'model', user: 'model', model: 'agent', provider: 'model', label: 'user' }

const METRICS = [
  { id: 'cost',     label: 'Costo' },
  { id: 'requests', label: 'Requests' },
  { id: 'tokens',   label: 'Tokens' },
  { id: 'co2',      label: 'CO2e' },
]

const PERIODS = [
  { id: 'month', label: 'Este mes' },
  { id: '7d',    label: 'Últimos 7 días' },
  { id: '30d',   label: 'Últimos 30 días' },
  { id: 'prev',  label: 'Mes pasado' },
]

const iso = d => d.toISOString().slice(0, 10)
function range(period) {
  const now = new Date()
  const y = now.getUTCFullYear(), m = now.getUTCMonth()
  const day = 864e5
  if (period === '7d')  return { from: iso(new Date(now - 6 * day)), to: iso(now) }
  if (period === '30d') return { from: iso(new Date(now - 29 * day)), to: iso(now) }
  if (period === 'prev') return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) }
  return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(now) }
}
function daysBetween(from, to) {
  const out = []
  for (let d = new Date(`${from}T00:00:00Z`); iso(d) <= to; d = new Date(d.getTime() + 864e5)) out.push(iso(d))
  return out
}

const nf = (v, digits = 0) => Number(v ?? 0).toLocaleString('es-UY', { minimumFractionDigits: digits, maximumFractionDigits: digits })
function usd(v) {
  const n = Number(v ?? 0)
  if (n === 0) return 'US$ 0'
  if (n < 0.01) return `US$ ${n.toLocaleString('es-UY', { maximumSignificantDigits: 2 })}`
  return `US$ ${nf(n, 2)}`
}
function tokens(v) {
  const n = Number(v ?? 0)
  if (n >= 1e6) return `${nf(n / 1e6, 1)} M`
  if (n >= 1e3) return `${nf(n / 1e3, 1)} k`
  return nf(n)
}
const ms = v => (v == null ? '—' : v >= 1000 ? `${nf(v / 1000, 1)} s` : `${nf(v)} ms`)
const pct = (a, b) => (b ? `${nf((a / b) * 100, a / b < 0.1 ? 1 : 0)} %` : '—')
const metricText = (metric, v) => (metric === 'cost' ? usd(v) : metric === 'tokens' ? tokens(v) : metric === 'co2' ? co2(v) : nf(v))

/** A group's emissions: the middle of its range, its range, and what lacks an estimate. */
function Emissions({ impact }) {
  if (!impact.gwp_g) return <span className="text-muted" title="Ningún modelo de este grupo tiene estimación">{impact.missing ? 'sin dato' : '—'}</span>
  const { min, max } = impact.gwp_g
  return (
    <span title={`Entre ${co2(min)} y ${co2(max)}${impact.missing ? ` · ${nf(impact.missing)} requests sin dato` : ''}`}>
      {co2(middle(impact.gwp_g))}{impact.missing > 0 && <span className="text-muted">*</span>}
    </span>
  )
}
function ago(t) {
  if (!t) return '—'
  const s = (Date.now() - new Date(t).getTime()) / 1000
  if (s < 90) return 'recién'
  if (s < 3600) return `hace ${Math.round(s / 60)} min`
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`
  return new Date(t).toLocaleDateString('es-UY', { day: 'numeric', month: 'short' })
}

function Tile({ label, value, note, tone }) {
  return (
    <div className={`flex flex-col gap-1.5 p-[18px] rounded-[10px] border ${tone === 'warn' ? 'bg-[#fffaf2] border-[#f0d9b5]' : 'bg-card border-border'}`}>
      <span className="text-[13px] text-muted">{label}</span>
      <span className="text-[26px] font-semibold text-strong tabular">{value}</span>
      {note && <span className={`text-xs ${tone === 'warn' ? 'text-warn' : 'text-muted'}`}>{note}</span>}
    </div>
  )
}

function ChartTooltip({ active, payload, label, metric, names }) {
  if (!active || !payload?.length) return null
  const rows = payload.filter(p => p.value > 0).reverse()
  const total = payload.reduce((a, p) => a + (p.value || 0), 0)
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2.5 shadow-dropdown text-xs space-y-1 min-w-[180px]">
      <div className="font-semibold text-strong">{new Date(`${label}T00:00:00Z`).toLocaleDateString('es-UY', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</div>
      {rows.map(p => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-default"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: p.fill }} />{names[p.dataKey]}</span>
          <span className="text-strong tabular">{metricText(metric, p.value)}</span>
        </div>
      ))}
      <div className="flex justify-between gap-4 border-t border-border pt-1"><span className="text-muted">Total</span><span className="text-strong tabular">{metricText(metric, total)}</span></div>
    </div>
  )
}

export default function UsagePage() {
  const [period, setPeriod] = useState('month')
  const [by, setBy]         = useState('team')
  const [filter, setFilter] = useState(null)  // { kind, value }
  const [metric, setMetric] = useState(null)  // null: cost, or requests when nothing has a cost
  const [data, setData]     = useState(null)
  const [error, setError]   = useState('')
  const [ready, setReady]   = useState(false)
  const latest = useRef(0) // only the last request's answer is shown

  // Deep links: /usage?agent=<id> (from Agentes), ?team=, ?by=
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    for (const d of DIMS) {
      const v = q.get(d.id)
      if (v) { setFilter({ kind: d.id, value: v }); setBy(NEXT[d.id]); break }
    }
    const b = q.get('by')
    if (DIMS.some(d => d.id === b)) setBy(b)
    setReady(true)
  }, [])

  const load = useCallback(async () => {
    const { from, to } = range(period)
    const q = new URLSearchParams({ by, from, to })
    if (filter) q.set(filter.kind, filter.value)
    setError('')
    const mine = ++latest.current
    const res = await fetch(`/api/consumption?${q}`).catch(() => null)
    const body = res ? await res.json().catch(() => ({})) : {}
    if (mine !== latest.current) return // a newer selection is on its way
    if (!res?.ok) { setError(body.message ?? 'No se pudo cargar el consumo.'); setData(null); return }
    setData(body)
    // Keep the address shareable.
    const url = new URL(window.location.href)
    url.search = filter ? `?${filter.kind}=${encodeURIComponent(filter.value)}&by=${by}` : `?by=${by}`
    window.history.replaceState(null, '', url)
  }, [period, by, filter])

  useEffect(() => { if (ready) load() }, [ready, load])

  const shown = metric ?? (data && data.totals.cost === 0 && data.totals.requests > 0 ? 'requests' : 'cost')

  // Top five groups by the shown metric get a color; the rest stack as "Otros".
  const chart = useMemo(() => {
    if (!data) return null
    const value = r => (shown === 'tokens' ? r.tokens_in + r.tokens_out : shown === 'co2' ? middle(r.impact.gwp_g) ?? 0 : r[shown])
    const ranked = [...data.rows].sort((a, b) => value(b) - value(a))
    const top = ranked.slice(0, SLOTS.length).filter(r => value(r) > 0).map(r => r.key ?? 'null')
    const names = Object.fromEntries(data.rows.map(r => [r.key ?? 'null', r.label]))
    names[OTHER_KEY] = 'Otros'
    const { from, to } = range(period)
    const days = daysBetween(from, to).map(day => ({ day }))
    const byDay = Object.fromEntries(days.map(d => [d.day, d]))
    let other = false
    for (const d of data.days) {
      const row = byDay[d.day]
      if (!row) continue
      const k = top.includes(d.key ?? 'null') ? d.key ?? 'null' : OTHER_KEY
      if (k === OTHER_KEY) other = true
      row[k] = (row[k] ?? 0) + d[shown]
    }
    const series = [...top, ...(other ? [OTHER_KEY] : [])]
    return { days, series, names, color: k => (k === OTHER_KEY ? OTHER : SLOTS[top.indexOf(k)]) }
  }, [data, shown, period])

  const t = data?.totals
  const dims = DIMS.filter(d => d.id !== filter?.kind)

  const tabBtn = (on) => `min-h-[36px] px-3 rounded-md text-[13px] border ${
    on ? 'bg-ink border-ink text-white' : 'bg-card border-border-strong text-strong hover:bg-raised'}`

  return (
    <div className="px-4 py-6 md:px-10 md:py-8 max-w-screen-xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-[26px] font-semibold text-strong tracking-tight">Consumo</h1>
          {filter ? (
            <p className="text-sm text-muted">
              {dimOf(filter.kind).one}: <span className="font-semibold text-strong">{data?.filter?.label ?? filter.value}</span>
              {' · '}
              <button type="button" onClick={() => { setFilter(null); setBy(filter.kind) }} className="text-accent hover:text-accent-hover">
                Ver todo
              </button>
            </p>
          ) : (
            <p className="text-sm text-muted">Por equipo, agente, persona, modelo, proveedor o etiqueta. Tocá una fila para ver su detalle.</p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="period" className="text-xs text-muted">Período</label>
          <select id="period" value={period} onChange={e => setPeriod(e.target.value)}
            className="h-10 px-2.5 rounded-md border border-border-strong bg-card text-sm text-strong">
            {PERIODS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
      </header>

      <div role="group" aria-label="Agrupar por" className="flex flex-wrap gap-1.5">
        {dims.map(d => (
          <button key={d.id} type="button" aria-pressed={by === d.id} onClick={() => setBy(d.id)} className={tabBtn(by === d.id)}>
            {d.label}
          </button>
        ))}
      </div>

      {error && <p role="alert" className="text-sm text-err bg-err-light rounded-md px-4 py-3">{error}</p>}

      {t && (
        <section aria-label="Resumen" className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
          <Tile label="Costo estimado" value={usd(t.cost)} note="Tokens × precio de lista del catálogo" />
          <Tile label="Requests" value={nf(t.requests)}
            note={`${pct(t.errors, t.requests)} con error · ${nf(t.blocked)} rechazados por política`}
            tone={t.requests && t.errors / t.requests > 0.05 ? 'warn' : undefined} />
          <Tile label="Tokens" value={tokens(t.tokens_in + t.tokens_out)} note={`${tokens(t.tokens_in)} de entrada · ${tokens(t.tokens_out)} de salida`} />
          <Tile label="Latencia p95" value={ms(t.p95_ms)} note={`p50 ${ms(t.p50_ms)} · de los requests que llegaron al proveedor`} />
          <Tile label="Emisiones estimadas"
            value={t.impact.gwp_g ? `${co2(middle(t.impact.gwp_g))} CO2e` : 'Sin dato'}
            note={t.impact.gwp_g
              ? `entre ${co2(t.impact.gwp_g.min)} y ${co2(t.impact.gwp_g.max)} · ${energy(middle(t.impact.energy_wh))} · ${water(middle(t.impact.water_ml))} de agua`
                + (t.impact.missing ? ` · ${nf(t.impact.missing)} requests sin dato` : '')
              : t.impact.missing ? `${nf(t.impact.missing)} requests de modelos sin estimación` : 'Sin requests con respuesta'} />
        </section>
      )}

      {chart && (
        <section aria-labelledby="daily" className="bg-card border border-border rounded-[10px] px-5 md:px-6 py-5 space-y-3.5">
          <div className="flex flex-wrap justify-between items-baseline gap-2.5">
            <h2 id="daily" className="text-base font-semibold text-strong">{METRICS.find(m => m.id === shown).label} por día</h2>
            <div role="group" aria-label="Medida" className="flex gap-1.5">
              {METRICS.map(m => (
                <button key={m.id} type="button" aria-pressed={shown === m.id} onClick={() => setMetric(m.id)} className={tabBtn(shown === m.id)}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          {chart.series.length > 1 && (
            <ul className="flex flex-wrap gap-x-3.5 gap-y-1 text-[13px] text-default" aria-label="Referencias">
              {chart.series.map(k => (
                <li key={k} className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ background: chart.color(k) }} aria-hidden="true" />
                  {chart.names[k]}
                </li>
              ))}
            </ul>
          )}
          {chart.series.length === 0 ? (
            <p className="text-sm text-muted py-10 text-center">Sin requests en este período.</p>
          ) : (
            <div className="h-[220px]" role="img" aria-label={`${METRICS.find(m => m.id === shown).label} por día, apilado por ${dimOf(by).one.toLowerCase()}. La tabla de abajo tiene los mismos datos.`}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart.days} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barCategoryGap="20%">
                  <CartesianGrid vertical={false} stroke="#eef0f3" />
                  <XAxis dataKey="day" tickLine={false} axisLine={{ stroke: '#c9ced6' }} tick={{ fontSize: 11, fill: '#6b7380' }}
                    tickFormatter={d => String(Number(d.slice(8, 10)))} interval="preserveStartEnd" minTickGap={8} />
                  <YAxis tickLine={false} axisLine={false} width={64} tick={{ fontSize: 11, fill: '#6b7380' }}
                    tickFormatter={v => metricText(shown, v)} allowDecimals={shown === 'cost' || shown === 'co2'} />
                  <Tooltip cursor={{ fill: '#eef0f3' }} content={<ChartTooltip metric={shown} names={chart.names} />} />
                  {chart.series.map((k, i) => (
                    <Bar key={k} dataKey={k} stackId="a" fill={chart.color(k)} stroke="#ffffff" strokeWidth={1}
                      radius={i === chart.series.length - 1 ? [4, 4, 0, 0] : 0} isAnimationActive={false} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <p className="text-xs text-muted">Días en UTC.</p>
        </section>
      )}

      {data && (
        <section aria-labelledby="table" className="bg-card border border-border rounded-[10px] overflow-x-auto">
          <h2 id="table" className="px-5 pt-[18px] pb-1.5 text-base font-semibold text-strong">Por {dimOf(by).one.toLowerCase()}</h2>
          {data.rows.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted">Sin requests en este período.</p>
          ) : (
            <table className="w-full min-w-[1000px] text-sm tabular">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-5 py-2.5 font-semibold">{dimOf(by).one}</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Requests</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Con error</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Rechazados</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Tokens ent. / sal.</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Costo</th>
                  <th className="px-3 py-2.5 font-semibold text-right">CO2e est.</th>
                  <th className="px-3 py-2.5 font-semibold text-right">p50 / p95</th>
                  <th className="px-5 py-2.5 font-semibold">Último uso</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map(r => {
                  const k = r.key ?? 'null'
                  const swatch = chart?.series.includes(k) ? chart.color(k) : chart?.series.includes(OTHER_KEY) ? OTHER : null
                  return (
                    <tr key={k} className="border-t border-border">
                      <td className="px-5 py-2.5">
                        <span className="inline-flex items-center gap-2">
                          {swatch && <span className="w-2.5 h-2.5 rounded-sm flex-none" style={{ background: swatch }} aria-hidden="true" />}
                          {r.key ? (
                            <button type="button" onClick={() => { setFilter({ kind: by, value: r.key }); setBy(NEXT[by]) }}
                              className={`text-left text-accent hover:text-accent-hover ${by === 'model' || by === 'label' ? 'font-mono text-[13px]' : ''}`}>
                              {r.label}
                            </button>
                          ) : <span className="text-muted">{r.label}</span>}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right">{nf(r.requests)}</td>
                      <td className={`px-3 py-2.5 text-right ${r.requests && r.errors / r.requests > 0.05 ? 'text-warn font-semibold' : ''}`}>{pct(r.errors, r.requests)}</td>
                      <td className="px-3 py-2.5 text-right">{nf(r.blocked)}</td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">{tokens(r.tokens_in)} / {tokens(r.tokens_out)}</td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">{usd(r.cost)}</td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap"><Emissions impact={r.impact} /></td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">{ms(r.p50_ms)} / {ms(r.p95_ms)}</td>
                      <td className="px-5 py-2.5 text-muted whitespace-nowrap">{ago(r.last_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      <p className="text-[13px] text-muted max-w-3xl leading-relaxed">
        Costo estimado = tokens que informa el proveedor × precio de lista del catálogo vigente al registrar el request.
        No reemplaza la factura: no incluye impuestos, créditos ni descuentos. Con error: respuestas 4xx y 5xx, incluidos
        los rechazos por política (modelo o proveedor no permitido, cuota, datos sensibles).
      </p>
      <p className="text-[13px] text-muted max-w-3xl leading-relaxed">
        Emisiones, energía y agua son estimaciones con el método de EcoLogits, a partir del modelo, los tokens de salida y la
        duración de cada request. Muestran el valor medio; el rango (al pasar el mouse) viene de que los modelos cerrados no
        publican su tamaño. No incluyen el entrenamiento de los modelos, la red ni los dispositivos. Un modelo sin estimación
        (propio o local) figura como «sin dato» y lo marca un asterisco, nunca como cero.{' '}
        <a href={METHOD_URL} target="_blank" rel="noreferrer" className="text-accent hover:text-accent-hover">Cómo se estima</a>
      </p>
    </div>
  )
}
