import { formatCost, formatTokens } from '../lib/format'

function StatCard({ label, value, sub, icon }) {
  return (
    <div className="bg-card rounded-xl border border-border shadow-card p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-muted uppercase tracking-widest">{label}</span>
        <span className="text-lg">{icon}</span>
      </div>
      <div className="text-2xl font-bold text-strong tabular-nums">{value}</div>
      {sub && <div className="text-xs text-subtle mt-1.5">{sub}</div>}
    </div>
  )
}

export default function StatsCards({ stats }) {
  const tokens = parseInt(stats.total_tokens  ?? 0)
  const cost   = parseFloat(stats.total_cost  ?? 0)
  const reqs   = parseInt(stats.total_requests ?? 0)
  const teams  = parseInt(stats.active_teams   ?? 0)

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard label="Requests"      value={reqs.toLocaleString()}  sub="this month"         icon="↗" />
      <StatCard label="Tokens"        value={formatTokens(tokens)}   sub="input + output"     icon="⬡" />
      <StatCard label="Estimated cost"value={formatCost(cost)}       sub="USD · current month" icon="$" />
      <StatCard label="Active teams"  value={String(teams)}          sub="with requests"      icon="◈" />
    </div>
  )
}
