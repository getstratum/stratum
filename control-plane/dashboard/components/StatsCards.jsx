import { formatCost, formatTokens, nf } from '../lib/format'
import { co2 } from '../lib/impacts/format'

function StatCard({ label, value, sub }) {
  return (
    <div className="bg-card rounded-[10px] border border-border p-[18px] flex flex-col gap-1.5">
      <span className="text-[13px] text-muted">{label}</span>
      <span className="text-[26px] font-semibold text-strong tabular">{value}</span>
      {sub && <span className="text-xs text-muted">{sub}</span>}
    </div>
  )
}

export default function StatsCards({ stats }) {
  const tokens = parseInt(stats.total_tokens  ?? 0)
  const cost   = parseFloat(stats.total_cost  ?? 0)
  const reqs   = parseInt(stats.total_requests ?? 0)
  const teams  = parseInt(stats.active_teams   ?? 0)
  const gwpMin = stats.gwp_g_min == null ? null : parseFloat(stats.gwp_g_min)
  const gwpMax = stats.gwp_g_max == null ? null : parseFloat(stats.gwp_g_max)
  const missing = parseInt(stats.impact_missing ?? 0)

  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
      <StatCard label="Requests"        value={nf(reqs)} sub="en el período" />
      <StatCard label="Tokens"          value={formatTokens(tokens)}   sub="entrada + salida" />
      <StatCard label="Costo estimado"  value={formatCost(cost)}       sub="según los precios de cada modelo" />
      <StatCard label="Equipos activos" value={nf(teams)}          sub="con requests" />
      <StatCard label="Emisiones estimadas"
        value={gwpMin == null ? 'Sin dato' : `${co2((gwpMin + gwpMax) / 2)} CO2e`}
        sub={gwpMin == null ? 'ningún modelo con estimación' : `entre ${co2(gwpMin)} y ${co2(gwpMax)}${missing ? ` · ${nf(missing)} sin dato` : ''}`} />
    </div>
  )
}
