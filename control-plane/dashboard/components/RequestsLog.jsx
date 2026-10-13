'use client'

import { useState } from 'react'
import { formatCost } from '../lib/format'

function StatusBadge({ code }) {
  if (!code) return <span className="text-subtle text-xs">—</span>
  const ok = code >= 200 && code < 300
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full font-mono
      ${ok ? 'bg-ok-light text-ok' : 'bg-err-light text-err'}`}>
      {code}
    </span>
  )
}

function ProviderBadge({ provider }) {
  const styles = {
    openai:    'bg-green-50 text-green-700 border-green-200',
    anthropic: 'bg-orange-50 text-orange-700 border-orange-200',
  }
  return (
    <span className={`text-xs border rounded-full px-2 py-0.5 font-medium ${styles[provider] ?? 'bg-gray-50 text-gray-600 border-gray-200'}`}>
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
      <div className="w-12 text-xs text-muted font-mono text-right flex-shrink-0">{ms}ms</div>
      <div className="w-8 text-xs text-subtle text-right flex-shrink-0">{pct}%</div>
    </div>
  )
}

function TraceDetail({ log }) {
  const auth     = log.auth_ms     ?? 0
  const policy   = log.policy_ms   ?? 0
  const provider = log.provider_ms ?? 0
  const total    = log.latency_ms  ?? 0
  const other    = Math.max(0, total - auth - policy - provider)
  const hasTrace = auth > 0 || policy > 0 || provider > 0

  return (
    <tr className="bg-raised">
      <td colSpan={11} className="px-6 py-4 border-t border-border">
        {hasTrace ? (
          <div className="max-w-lg space-y-2.5">
            <div className="text-xs text-muted mb-3">
              Trace <span className="font-mono text-subtle">{log.trace_id?.slice(0, 8) ?? '—'}</span>
              {' · '}total <span className="font-semibold text-strong">{total}ms</span>
            </div>
            <TraceBar label="Auth"     ms={auth}     total={total} color="bg-accent" />
            <TraceBar label="Policy"   ms={policy}   total={total} color="bg-accent/60" />
            <TraceBar label="Provider" ms={provider} total={total} color="bg-accent/30" />
            {other > 2 && <TraceBar label="Other" ms={other} total={total} color="bg-border" />}
          </div>
        ) : (
          <div className="text-xs text-subtle">
            Per-stage timing not available for this request.
          </div>
        )}
      </td>
    </tr>
  )
}

export default function RequestsLog({ logs }) {
  const [expanded, setExpanded] = useState(null)

  if (!logs?.length) {
    return (
      <div className="bg-card border border-border rounded-xl shadow-card px-5 py-10 text-center text-muted text-sm">
        No requests yet. Make a call to the gateway to see logs here.
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-xl shadow-card overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted uppercase tracking-widest bg-raised border-b border-border">
            <th className="px-4 py-3 text-left w-6" />
            <th className="px-4 py-3 text-left font-semibold">Timestamp</th>
            <th className="px-4 py-3 text-left font-semibold">Provider</th>
            <th className="px-4 py-3 text-left font-semibold">Model</th>
            <th className="px-4 py-3 text-left font-semibold">Team</th>
            <th className="px-4 py-3 text-left font-semibold">Source</th>
            <th className="px-4 py-3 text-right font-semibold">In</th>
            <th className="px-4 py-3 text-right font-semibold">Out</th>
            <th className="px-4 py-3 text-right font-semibold">Cost</th>
            <th className="px-4 py-3 text-right font-semibold">Latency</th>
            <th className="px-4 py-3 text-center font-semibold">Status</th>
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
                <td className="px-4 py-3.5 text-xs text-muted font-mono whitespace-nowrap">
                  {new Date(log.created_at).toLocaleString('en-US', {
                    month: 'short', day: '2-digit',
                    hour: '2-digit', minute: '2-digit', second: '2-digit',
                    hour12: false,
                  })}
                </td>
                <td className="px-4 py-3.5">
                  <ProviderBadge provider={log.provider} />
                </td>
                <td className="px-4 py-3.5 font-mono text-xs text-default">{log.model_id}</td>
                <td className="px-4 py-3.5 text-xs text-muted">{log.team_name ?? '—'}</td>
                <td className="px-4 py-3.5 text-xs">
                  {log.agent_name
                    ? <span className="bg-accent-light text-accent-text text-xs font-medium rounded-full px-2 py-0.5">agent</span>
                    : <span className="text-muted">user</span>}
                </td>
                <td className="px-4 py-3.5 text-right text-xs text-muted font-mono tabular-nums">
                  {parseInt(log.tokens_input).toLocaleString()}
                </td>
                <td className="px-4 py-3.5 text-right text-xs text-muted font-mono tabular-nums">
                  {parseInt(log.tokens_output).toLocaleString()}
                </td>
                <td className="px-4 py-3.5 text-right text-xs font-semibold font-mono tabular-nums text-accent-text">
                  {formatCost(log.cost_usd)}
                </td>
                <td className="px-4 py-3.5 text-right text-xs font-mono tabular-nums">
                  {log.latency_ms
                    ? <span className={log.latency_ms > 3000 ? 'text-warn font-semibold' : 'text-muted'}>{log.latency_ms}ms</span>
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
