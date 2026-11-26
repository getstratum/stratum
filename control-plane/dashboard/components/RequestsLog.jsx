'use client'

import { useState } from 'react'
import { formatCost, formatDateTime, formatMs, nf } from '../lib/format'
import { useNarrow } from './useNarrow'
import { typeLabel } from '../lib/sensitive'

function StatusBadge({ code }) {
  if (!code) return <span className="text-subtle text-xs">—</span>
  const ok = code >= 200 && code < 300
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full tabular
      ${ok ? 'bg-ok-light text-ok' : 'bg-err-light text-err'}`}>
      {code}
    </span>
  )
}

function ProviderBadge({ provider }) {
  return (
    <span className="text-xs text-default border border-border rounded px-2 py-0.5 whitespace-nowrap">
      {provider}
    </span>
  )
}

function TraceBar({ label, ms, total, color }) {
  const pct = total > 0 ? Math.max(2, Math.round((ms / total) * 100)) : 0
  return (
    <div className="flex items-center gap-3">
      <div className="w-16 text-xs text-muted text-right flex-shrink-0">{label}</div>
      <div className="flex-1 h-1.5 bg-app rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="w-16 text-xs text-muted tabular text-right flex-shrink-0">{formatMs(ms)}</div>
      <div className="w-10 text-xs text-subtle tabular text-right flex-shrink-0">{pct} %</div>
    </div>
  )
}

// Labels that say something went differently from usual, for whoever reads
// the row (the gateway sets them; the application's own go as they came).
const NOTED_LABELS = {
  decision_skipped: 'Los servicios de decisión no contestaron a tiempo: el pedido siguió sin su decisión.',
  tool_approved: 'Una persona aprobó esta llamada en el portal.',
}

function RequestFacts({ log }) {
  const labels = Array.isArray(log.labels) ? log.labels : []
  const secs = log.audio_seconds != null ? Math.round(parseFloat(log.audio_seconds)) : 0
  const sensitive = Array.isArray(log.pii_types) ? log.pii_types : []
  const cacheW = Number(log.tokens_cache_write ?? 0)
  const cacheR = Number(log.tokens_cache_read ?? 0)
  if (!log.error_message && !labels.length && !log.images && !secs && !sensitive.length && !cacheW && !cacheR) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs mb-3" data-testid="request-facts">
      {log.error_message && (
        <span className="text-muted">
          Motivo <code className="font-mono text-strong">{log.error_message}</code>
        </span>
      )}
      {(cacheW > 0 || cacheR > 0) && (
        <span className="text-muted" data-testid="request-cache"
              title="Parte de la entrada que el proveedor guardó o leyó de su caché de prompts; cada parte se cobra a su precio (Modelos).">
          De la entrada, caché: <span className="text-strong tabular">{nf(cacheW)}</span> escritos · <span className="text-strong tabular">{nf(cacheR)}</span> leídos
        </span>
      )}
      {log.images > 0 && <span className="text-muted">Imágenes <span className="text-strong tabular">{log.images}</span></span>}
      {secs > 0 && (
        <span className="text-muted">Audio <span className="text-strong tabular">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span></span>
      )}
      {sensitive.length > 0 && (
        <span className="flex flex-wrap items-center gap-1.5 text-muted" data-testid="request-sensitive"
              title="Lo que la política de PII y DLP encontró en el pedido: según la política, quedó registrado, se ocultó o frenó el pedido.">
          Datos sensibles
          {sensitive.map(t => <span key={t} className="rounded px-1.5 py-0.5 bg-warn-light text-warn">{typeLabel(t)}</span>)}
        </span>
      )}
      {labels.length > 0 && (
        <span className="flex flex-wrap items-center gap-1.5 text-muted">
          Etiquetas
          {labels.map(l => (
            <span key={l} title={NOTED_LABELS[l]}
                  className={`font-mono rounded px-1.5 py-0.5 ${l === 'decision_skipped' ? 'bg-warn-light text-warn' : 'bg-app text-default'}`}>
              {l}
            </span>
          ))}
        </span>
      )}
    </div>
  )
}

function TraceBody({ log }) {
  const auth     = log.auth_ms     ?? 0
  const policy   = log.policy_ms   ?? 0
  const provider = log.provider_ms ?? 0
  const total    = log.latency_ms  ?? 0
  const other    = Math.max(0, total - auth - policy - provider)
  const hasTrace = auth > 0 || policy > 0 || provider > 0

  return (
    <>
        <RequestFacts log={log} />
        {hasTrace ? (
          <div className="max-w-lg space-y-2.5">
            <div className="text-xs text-muted mb-3">
              Traza <span className="font-mono text-subtle">{log.trace_id?.slice(0, 8) ?? '—'}</span>
              {' · '}total <span className="font-semibold text-strong tabular">{formatMs(total)}</span>
            </div>
            <TraceBar label="Auth"     ms={auth}     total={total} color="bg-accent" />
            <TraceBar label="Política"   ms={policy}   total={total} color="bg-accent/60" />
            <TraceBar label="Proveedor" ms={provider} total={total} color="bg-accent/30" />
            {other > 2 && <TraceBar label="Otro" ms={other} total={total} color="bg-border" />}
          </div>
        ) : (
          <div className="text-xs text-subtle">
            Este pedido no tiene los tiempos por etapa.
          </div>
        )}
    </>
  )
}

function TraceDetail({ log }) {
  return (
    <tr className="bg-raised">
      <td colSpan={11} className="px-6 py-4 border-t border-border">
        <TraceBody log={log} />
      </td>
    </tr>
  )
}

function Who({ log }) {
  if (!log.agent_name) return <span className="text-muted" title="Persona">{log.user_email ?? 'persona'}</span>
  if (!log.user_email) return <span className="text-default" title="Agente">{log.agent_name}</span>
  return (
    <span title={`El agente ${log.agent_name}, en nombre de ${log.user_email}`}>
      <span className="text-default">{log.agent_name}</span>
      <span className="text-muted"> · por {log.user_email}</span>
    </span>
  )
}

function Cost({ log }) {
  return log.cost_usd == null
    ? <span className="text-muted" title="El modelo no tiene precio: poné uno en Modelos para que cuente.">Sin precio</span>
    : formatCost(log.cost_usd)
}

// On a phone: one card per request, the same facts; a tap opens its trace.
function RequestCards({ logs, expanded, setExpanded }) {
  return (
    <ul className="bg-card border border-border rounded-[10px] divide-y divide-border">
      {logs.map(log => {
        const isOpen = expanded === log.id
        return (
          <li key={log.id}>
            <button type="button" onClick={() => setExpanded(isOpen ? null : log.id)} aria-expanded={isOpen}
                    className="w-full text-left px-4 py-3 flex flex-col gap-1.5 hover:bg-raised">
              <span className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted tabular">{isOpen ? '▾' : '▸'} {formatDateTime(log.created_at, { seconds: true })}</span>
                <StatusBadge code={log.status_code} />
              </span>
              <span className="flex items-center gap-2 min-w-0">
                <ProviderBadge provider={log.provider} />
                <span className="font-mono text-xs text-default truncate">{log.model_id}</span>
              </span>
              <span className="text-xs truncate"><Who log={log} />{log.team_name ? <span className="text-subtle"> · {log.team_name}</span> : null}</span>
              <span className="flex flex-wrap gap-x-3 text-xs text-muted tabular">
                <span>{nf(log.tokens_input)} ent. · {nf(log.tokens_output)} sal.</span>
                <span className="text-strong"><Cost log={log} /></span>
                {log.latency_ms ? <span className={log.latency_ms > 3000 ? 'text-warn font-semibold' : ''}>{formatMs(log.latency_ms)}</span> : null}
              </span>
            </button>
            {isOpen && <div className="bg-raised px-4 py-3 border-t border-border"><TraceBody log={log} /></div>}
          </li>
        )
      })}
    </ul>
  )
}

export default function RequestsLog({ logs }) {
  const [expanded, setExpanded] = useState(null)
  const narrow = useNarrow()

  if (!logs?.length) {
    return (
      <div className="bg-card border border-border rounded-[10px] px-5 py-10 text-center text-muted text-sm">
        Todavía no hay requests. Cuando un cliente llame al gateway, aparecen acá.
      </div>
    )
  }

  if (narrow) return <RequestCards logs={logs} expanded={expanded} setExpanded={setExpanded} />

  return (
    <div className="relative bg-card border border-border rounded-[10px] overflow-x-auto" tabIndex={0} role="region" aria-label="Requests">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="text-xs text-muted uppercase tracking-wider bg-raised border-b border-border">
            <th className="px-4 py-3 text-left w-6" />
            <th className="px-4 py-3 text-left font-semibold">Fecha</th>
            <th className="px-4 py-3 text-left font-semibold">Proveedor</th>
            <th className="px-4 py-3 text-left font-semibold">Modelo</th>
            <th className="px-4 py-3 text-left font-semibold">Equipo</th>
            <th className="px-4 py-3 text-left font-semibold">Quién</th>
            <th className="px-4 py-3 text-right font-semibold">Ent.</th>
            <th className="px-4 py-3 text-right font-semibold">Sal.</th>
            <th className="px-4 py-3 text-right font-semibold">Costo</th>
            <th className="px-4 py-3 text-right font-semibold">Latencia</th>
            <th className="px-4 py-3 text-center font-semibold">Estado</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {logs.map(log => {
            const isOpen = expanded === log.id
            return [
              <tr
                key={log.id}
                className="hover:bg-raised cursor-pointer transition-colors"
                onClick={() => setExpanded(isOpen ? null : log.id)}
              >
                <td className="px-4 py-3.5 text-muted text-xs select-none">
                  {isOpen ? '▾' : '▸'}
                </td>
                <td className="px-4 py-3.5 text-xs text-muted tabular whitespace-nowrap">
                  {formatDateTime(log.created_at, { seconds: true })}
                </td>
                <td className="px-4 py-3.5">
                  <ProviderBadge provider={log.provider} />
                </td>
                <td className="px-4 py-3.5 font-mono text-xs text-default whitespace-nowrap">{log.model_id}</td>
                <td className="px-4 py-3.5 text-xs text-muted">{log.team_name ?? '—'}</td>
                <td className="px-4 py-3.5 text-xs max-w-[220px] truncate">
                  <Who log={log} />
                </td>
                <td className="px-4 py-3.5 text-right text-xs text-muted tabular">{nf(log.tokens_input)}</td>
                <td className="px-4 py-3.5 text-right text-xs text-muted tabular">{nf(log.tokens_output)}</td>
                <td className="px-4 py-3.5 text-right text-xs text-strong tabular whitespace-nowrap">
                  <Cost log={log} />
                </td>
                <td className="px-4 py-3.5 text-right text-xs tabular whitespace-nowrap">
                  {log.latency_ms
                    ? <span className={log.latency_ms > 3000 ? 'text-warn font-semibold' : 'text-muted'}>{formatMs(log.latency_ms)}</span>
                    : <span className="text-subtle">—</span>}
                </td>
                <td className="px-4 py-3.5 text-center">
                  <StatusBadge code={log.status_code} />
                </td>
              </tr>,
              isOpen && <TraceDetail key={`${log.id}-trace`} log={log} />,
            ]
          })}
        </tbody>
      </table>
    </div>
  )
}
