import { formatCost, formatCostCompact, formatTokens, nf } from '../lib/format'

function ProgressBar({ pct }) {
  const capped = Math.min(100, pct)
  const warn   = capped >= 80
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex-1 h-1.5 bg-app rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${warn ? 'bg-err' : 'bg-accent'}`}
          style={{ width: `${capped}%` }}
        />
      </div>
      <span className={`text-xs min-w-[3rem] text-right tabular font-medium ${warn ? 'text-err' : 'text-muted'}`}>
        {nf(pct)} %
      </span>
    </div>
  )
}

export default function TeamsTable({ teams, policies }) {
  const policyMap = Object.fromEntries((policies ?? []).map(p => [p.team_id, p]))

  if (!teams?.length) {
    return (
      <div className="bg-card border border-border rounded-[10px] px-5 py-10 text-center text-muted text-sm">
        Todavía no hay requests este mes.
      </div>
    )
  }

  return (
    <div className="relative bg-card border border-border rounded-[10px] overflow-x-auto">
      <div className="px-5 py-3.5 border-b border-border">
        <span className="text-xs font-semibold text-muted uppercase tracking-widest">
          Consumo por equipo · este mes
        </span>
      </div>
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="text-xs text-muted uppercase tracking-wider bg-raised border-b border-border">
            <th className="px-5 py-3 text-left font-semibold">Equipo</th>
            <th className="px-5 py-3 text-right font-semibold">Requests</th>
            <th className="px-5 py-3 text-right font-semibold">Tokens</th>
            <th className="px-5 py-3 text-right font-semibold">Costo</th>
            <th className="px-5 py-3 text-left font-semibold w-44">Presupuesto</th>
            <th className="px-5 py-3 text-left font-semibold">Política</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {teams.map(team => {
            const policy = policyMap[team.team_id]
            const budget = parseFloat(team.team_budget ?? policy?.monthly_budget_usd ?? 0)
            const spent  = parseFloat(team.total_cost ?? 0)
            const pct    = budget > 0 ? (spent / budget) * 100 : 0

            return (
              <tr key={team.team_id} className="hover:bg-raised transition-colors">
                <td className="px-5 py-4">
                  <div className="font-semibold text-strong">{team.team_name}</div>
                  <div className="text-xs text-muted mt-0.5">
                    {team.active_users} persona{team.active_users != 1 ? 's' : ''} activa{team.active_users != 1 ? 's' : ''}
                  </div>
                </td>
                <td className="px-5 py-4 text-right text-strong tabular text-sm">
                  {nf(team.total_requests)}
                </td>
                <td className="px-5 py-4 text-right text-strong tabular text-sm">
                  {formatTokens(team.total_tokens)}
                </td>
                <td className="px-5 py-4 text-right font-semibold tabular text-sm text-strong whitespace-nowrap">
                  {formatCost(spent)}
                </td>
                <td className="px-5 py-4">
                  {budget > 0 ? (
                    <>
                      <div className="text-xs text-muted mb-1.5 tabular">
                        de {formatCostCompact(budget)}
                      </div>
                      <ProgressBar pct={pct} />
                    </>
                  ) : <span className="text-xs text-subtle">Sin presupuesto</span>}
                </td>
                <td className="px-5 py-4">
                  {policy
                    ? <span className="text-xs text-default border border-border rounded px-2 py-0.5 whitespace-nowrap">{policy.policy_name}</span>
                    : <span className="text-xs text-warn">Sin política</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
