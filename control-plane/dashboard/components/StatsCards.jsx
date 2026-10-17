import { formatCost, formatTokens } from '../lib/format'

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-card rounded-[10px] border border-border p-[18px] flex flex-col gap-1.5">
      <span className="text-[13px] text-muted">{label}</span>
      <span className="text-[26px] font-semibold text-strong tabular-nums">{value}</span>
      {sub && <span className="text-xs text-muted">{sub}</span>}
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
      <StatCard label="Requests"        value={reqs.toLocaleString('es-UY')} sub="en el período" />
      <StatCard label="Tokens"          value={formatTokens(tokens)}   sub="entrada + salida" />
      <StatCard label="Costo estimado"  value={formatCost(cost)}       sub="US$, precios de lista" />
      <StatCard label="Equipos activos" value={String(teams)}          sub="con requests" />
    </div>
  )
}
