'use client'

// "Mi organización" (ADR-0020): the plan whoever runs Stratum set for the
// organization, each limit with what it has now, and its state. Nothing
// here changes the plan: it is fixed from outside the organization.

import { useEffect, useState } from 'react'
import { formatCost, formatTokens, nf } from '../../lib/format'

const STATUS = {
  active:    { text: 'Activa', cls: 'text-ok' },
  suspended: { text: 'Suspendida', cls: 'text-err' },
}

// In the order people think of them; units as the console shows them elsewhere.
const ROWS = [
  { key: 'people',             label: 'Personas activas',   fmt: v => nf(v), hint: 'Con acceso a la consola o a las aplicaciones.' },
  { key: 'agents',             label: 'Agentes activos',    fmt: v => nf(v) },
  { key: 'teams',              label: 'Equipos',            fmt: v => nf(v) },
  { key: 'gateways',           label: 'Gateways',           fmt: v => nf(v), hint: 'Registrados y no dados de baja.' },
  { key: 'monthly_tokens',     label: 'Tokens este mes',    fmt: v => formatTokens(v), hint: 'Todos los equipos juntos. Al llegar, los gateways rechazan los pedidos hasta el mes siguiente.' },
  { key: 'monthly_budget_usd', label: 'Gasto este mes',     fmt: v => formatCost(v), hint: 'Costo estimado, todos los equipos juntos. Al llegar, los gateways rechazan los pedidos hasta el mes siguiente.' },
]

// The paid functions a plan may include (Enterprise reads them; the console
// only shows what the plan says).
const FEATURES = {
  portal: 'Portal de chat',
  agent_guard: 'Guard de agentes',
  history_audit: 'Auditoría de conversaciones',
}

function Meter({ have, max }) {
  const pct = max > 0 ? Math.min(100, (have / max) * 100) : 100
  const tone = have >= max ? 'bg-err' : pct >= 80 ? 'bg-warn' : 'bg-ok'
  return (
    <div className="h-1.5 w-full rounded-full bg-raised overflow-hidden" aria-hidden="true">
      <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export default function OrganizationPage() {
  const [org, setOrg] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/org').then(async r => {
      const body = await r.json().catch(() => ({}))
      if (!r.ok) setError(body.message ?? 'No se pudo cargar la organización.')
      else setOrg(body)
    }).catch(() => setError('No se pudo conectar con la consola.'))
  }, [])

  return (
    <div className="px-4 py-6 md:px-10 md:py-8 max-w-screen-md">
      <h1 className="text-[26px] font-semibold text-strong tracking-tight">Mi organización</h1>
      {error && <p className="text-sm text-err bg-err-light rounded-lg px-4 py-3 mt-4">{error}</p>}
      {!org && !error && <p className="text-sm text-muted mt-4">Cargando…</p>}
      {org && (
        <>
          <p className="text-sm text-muted mt-1">
            {org.name} · <span className={`font-semibold ${STATUS[org.status]?.cls ?? ''}`}>{STATUS[org.status]?.text ?? org.status}</span>
          </p>

          <section className="bg-card border border-border rounded-[10px] mt-6" data-testid="plan">
            <div className="px-5 pt-5 pb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold text-strong">
                {org.plan ? <>Plan {org.plan}</> : 'Tu plan'}
              </h2>
              <p className="text-xs text-muted">Lo fija quien administra Stratum. Para cambiarlo, pedíselo.</p>
            </div>
            <ul className="divide-y divide-border">
              {ROWS.map(r => {
                const max = org.limits[r.key]
                const have = org.counts[r.key] ?? 0
                return (
                  <li key={r.key} className="px-5 py-3.5" data-testid={`limit-${r.key}`}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <span className="text-sm font-medium text-strong">{r.label}</span>
                      <span className="text-sm tabular-nums text-default">
                        {max == null
                          ? <>{r.fmt(have)} <span className="text-subtle">· sin límite</span></>
                          : <>{r.fmt(have)} <span className="text-muted">de {r.fmt(max)}</span></>}
                      </span>
                    </div>
                    {max != null && <div className="mt-2"><Meter have={have} max={max} /></div>}
                    {max != null && have >= max && ['people', 'agents', 'teams', 'gateways'].includes(r.key) && (
                      <p className="text-xs text-err mt-1.5">Llegaste al límite: no se pueden sumar más. Lo que ya existe sigue igual.</p>
                    )}
                    {r.hint && <p className="text-xs text-subtle mt-1">{r.hint}</p>}
                  </li>
                )
              })}
              <li className="px-5 py-3.5" data-testid="limit-retention_days">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="text-sm font-medium text-strong">Requests guardados</span>
                  <span className="text-sm text-default">
                    {org.limits.retention_days == null
                      ? <span className="text-subtle">sin límite</span>
                      : <>{nf(org.limits.retention_days)} días</>}
                  </span>
                </div>
                <p className="text-xs text-subtle mt-1">
                  {org.limits.retention_days == null
                    ? 'Los Requests se guardan sin fecha de borrado.'
                    : 'Los más viejos se borran una vez por día. El consumo por mes se conserva.'}
                </p>
              </li>
              {org.limits.portal_seats != null && (
                <li className="px-5 py-3.5" data-testid="limit-portal_seats">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="text-sm font-medium text-strong">Asientos del portal</span>
                    <span className="text-sm text-default">{nf(org.limits.portal_seats)} personas por mes</span>
                  </div>
                  <p className="text-xs text-subtle mt-1">Quienes usan el portal en un mes. El portal muestra cuántos van.</p>
                </li>
              )}
            </ul>
          </section>

          {org.features && (
            <section className="bg-card border border-border rounded-[10px] mt-6 px-5 py-4" data-testid="features">
              <h2 className="text-base font-semibold text-strong mb-2">Funciones incluidas</h2>
              {org.features.length === 0
                ? <p className="text-sm text-muted">Tu plan no incluye funciones Enterprise.</p>
                : (
                  <ul className="text-sm text-default list-disc pl-5 space-y-0.5">
                    {org.features.map(f => <li key={f}>{FEATURES[f] ?? f}</li>)}
                  </ul>
                )}
            </section>
          )}
        </>
      )}
    </div>
  )
}
