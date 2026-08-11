'use client'

import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  Tooltip, CartesianGrid, Cell, PieChart, Pie,
} from 'recharts'
import { formatCost, formatTokens } from '../lib/format'
import { toCSV, downloadCSV, PROVIDER_COLUMNS, MODEL_COLUMNS } from '../lib/csv'

function ExportBtn({ onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 text-xs text-muted hover:text-default border border-border rounded-lg px-2.5 py-1.5 bg-card hover:bg-raised transition-colors"
    >
      <svg width="11" height="11" viewBox="0 0 13 13" fill="none">
        <path d="M6.5 1v8M3.5 6l3 3 3-3M1 10.5h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      CSV
    </button>
  )
}

const COLORS = ['#7c3aed', '#a855f7', '#c084fc', '#ddd6fe', '#6366f1', '#818cf8']

// ─── Provider breakdown ───────────────────────────────────────────────────────

function ProviderTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2.5 shadow-dropdown text-xs">
      <div className="font-semibold text-strong mb-1.5 capitalize">{d.provider}</div>
      <div className="space-y-1 text-muted">
        <div className="flex justify-between gap-6"><span>Requests</span><span className="text-strong font-mono">{d.requests.toLocaleString()}</span></div>
        <div className="flex justify-between gap-6"><span>Tokens</span><span className="text-strong font-mono">{formatTokens(d.tokens)}</span></div>
        <div className="flex justify-between gap-6"><span>Cost</span><span className="text-accent font-mono font-semibold">{formatCost(d.cost)}</span></div>
        <div className="flex justify-between gap-6"><span>Avg latency</span><span className="text-strong font-mono">{d.avgLatency}ms</span></div>
      </div>
    </div>
  )
}

export function ProviderChart({ data }) {
  if (!data?.length) return (
    <div className="flex items-center justify-center h-48 text-sm text-muted">No data for this period</div>
  )

  const donutData = data.map((d, i) => ({
    name:  d.provider,
    value: parseFloat(d.cost),
    color: COLORS[i % COLORS.length],
  }))

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

      {/* Bar chart — cost + requests */}
      <div className="bg-card border border-border rounded-xl shadow-card p-5">
        <div className="flex items-center justify-between mb-4"><div className="text-xs font-semibold text-muted uppercase tracking-widest">Cost by provider</div><ExportBtn onClick={() => { const ts=new Date().toISOString().slice(0,10); downloadCSV(toCSV(data,PROVIDER_COLUMNS),`proxima-providers-${ts}.csv`) }} /></div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} barGap={6}>
            <CartesianGrid vertical={false} stroke="#f3f4f6" />
            <XAxis dataKey="provider" tick={{ fill: '#9ca3af', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} axisLine={false} tickLine={false}
              tickFormatter={v => formatCost(v)} width={72} />
            <Tooltip content={<ProviderTooltip />} cursor={{ fill: '#f9fafb' }} />
            <Bar dataKey="cost" radius={[4,4,0,0]}>
              {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Donut — cost share */}
      <div className="bg-card border border-border rounded-xl shadow-card p-5">
        <div className="text-xs font-semibold text-muted uppercase tracking-widest mb-4">Cost distribution</div>
        <div className="flex items-center gap-4">
          <ResponsiveContainer width={140} height={140}>
            <PieChart>
              <Pie data={donutData} cx="50%" cy="50%" innerRadius={42} outerRadius={64}
                dataKey="value" strokeWidth={2} stroke="#fff">
                {donutData.map((d, i) => <Cell key={i} fill={d.color} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="flex-1 space-y-2">
            {donutData.map((d, i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: d.color }} />
                  <span className="text-xs text-default capitalize">{d.name}</span>
                </div>
                <span className="text-xs font-mono font-semibold text-accent-text">{formatCost(d.value)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Stats table */}
      <div className="bg-card border border-border rounded-xl shadow-card overflow-hidden lg:col-span-2">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted uppercase tracking-widest bg-raised border-b border-border">
              <th className="px-5 py-3 text-left font-semibold">Provider</th>
              <th className="px-5 py-3 text-right font-semibold">Requests</th>
              <th className="px-5 py-3 text-right font-semibold">Tokens</th>
              <th className="px-5 py-3 text-right font-semibold">Cost</th>
              <th className="px-5 py-3 text-right font-semibold">Avg latency</th>
              <th className="px-5 py-3 text-right font-semibold">Errors</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.map((d, i) => (
              <tr key={d.provider} className="hover:bg-raised transition-colors">
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-2.5">
                    <span className="w-2.5 h-2.5 rounded-sm" style={{ background: COLORS[i % COLORS.length] }} />
                    <span className="font-semibold text-strong capitalize">{d.provider}</span>
                  </div>
                </td>
                <td className="px-5 py-3.5 text-right font-mono text-sm tabular-nums">{d.requests.toLocaleString()}</td>
                <td className="px-5 py-3.5 text-right font-mono text-sm tabular-nums">{formatTokens(d.tokens)}</td>
                <td className="px-5 py-3.5 text-right font-mono text-sm tabular-nums font-semibold text-accent-text">{formatCost(d.cost)}</td>
                <td className="px-5 py-3.5 text-right font-mono text-sm tabular-nums text-muted">{d.avgLatency}ms</td>
                <td className="px-5 py-3.5 text-right text-sm">
                  {d.errors > 0
                    ? <span className="text-err font-semibold">{d.errors}</span>
                    : <span className="text-muted">0</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Model breakdown ──────────────────────────────────────────────────────────

function ModelTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2.5 shadow-dropdown text-xs">
      <div className="font-semibold text-strong mb-1.5">{d.model}</div>
      <div className="text-xs text-muted mb-1">{d.provider}</div>
      <div className="space-y-1 text-muted">
        <div className="flex justify-between gap-6"><span>Requests</span><span className="text-strong font-mono">{d.requests.toLocaleString()}</span></div>
        <div className="flex justify-between gap-6"><span>Input tokens</span><span className="text-strong font-mono">{formatTokens(d.tokensInput)}</span></div>
        <div className="flex justify-between gap-6"><span>Output tokens</span><span className="text-strong font-mono">{formatTokens(d.tokensOutput)}</span></div>
        <div className="flex justify-between gap-6"><span>Cost</span><span className="text-accent font-mono font-semibold">{formatCost(d.cost)}</span></div>
      </div>
    </div>
  )
}

export function ModelChart({ data }) {
  if (!data?.length) return (
    <div className="flex items-center justify-center h-48 text-sm text-muted">No data for this period</div>
  )

  const chartData = [...data].sort((a, b) => b.cost - a.cost).slice(0, 8)

  return (
    <div className="space-y-5">
      {/* Horizontal bar — cost by model */}
      <div className="bg-card border border-border rounded-xl shadow-card p-5">
        <div className="text-xs font-semibold text-muted uppercase tracking-widest mb-4">Cost by model</div>
        <ResponsiveContainer width="100%" height={Math.max(180, chartData.length * 36)}>
          <BarChart data={chartData} layout="vertical" barCategoryGap="30%">
            <CartesianGrid horizontal={false} stroke="#f3f4f6" />
            <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 11 }} axisLine={false}
              tickLine={false} tickFormatter={v => formatCost(v)} />
            <YAxis type="category" dataKey="model" tick={{ fill: '#374151', fontSize: 11 }}
              axisLine={false} tickLine={false} width={160} />
            <Tooltip content={<ModelTooltip />} cursor={{ fill: '#f9fafb' }} />
            <Bar dataKey="cost" radius={[0,4,4,0]}>
              {chartData.map((d, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Detail table */}
      <div className="bg-card border border-border rounded-xl shadow-card overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-4 pb-0"><div className="text-xs font-semibold text-muted uppercase tracking-widest">Model detail</div><ExportBtn onClick={() => { const ts=new Date().toISOString().slice(0,10); downloadCSV(toCSV(data,MODEL_COLUMNS),`proxima-models-${ts}.csv`) }} /></div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted uppercase tracking-widest bg-raised border-b border-border">
              <th className="px-5 py-3 text-left font-semibold">Model</th>
              <th className="px-5 py-3 text-left font-semibold">Provider</th>
              <th className="px-5 py-3 text-right font-semibold">Requests</th>
              <th className="px-5 py-3 text-right font-semibold">Input</th>
              <th className="px-5 py-3 text-right font-semibold">Output</th>
              <th className="px-5 py-3 text-right font-semibold">Cost</th>
              <th className="px-5 py-3 text-right font-semibold">Avg latency</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.map((d, i) => (
              <tr key={`${d.provider}-${d.model}`} className="hover:bg-raised transition-colors">
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-sm" style={{ background: COLORS[i % COLORS.length] }} />
                    <span className="font-mono text-xs text-strong">{d.model}</span>
                  </div>
                </td>
                <td className="px-5 py-3.5 text-xs text-muted capitalize">{d.provider}</td>
                <td className="px-5 py-3.5 text-right font-mono text-xs tabular-nums">{d.requests.toLocaleString()}</td>
                <td className="px-5 py-3.5 text-right font-mono text-xs tabular-nums text-muted">{formatTokens(d.tokensInput)}</td>
                <td className="px-5 py-3.5 text-right font-mono text-xs tabular-nums text-muted">{formatTokens(d.tokensOutput)}</td>
                <td className="px-5 py-3.5 text-right font-mono text-xs tabular-nums font-semibold text-accent-text">{formatCost(d.cost)}</td>
                <td className="px-5 py-3.5 text-right font-mono text-xs tabular-nums text-muted">{d.avgLatency}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
