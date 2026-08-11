import { formatCost, formatTokens } from '../lib/format'

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
      <span className={`text-xs w-9 text-right tabular-nums font-medium ${warn ? 'text-err' : 'text-muted'}`}>
        {capped.toFixed(0)}%
      </span>
    </div>
  )
}

export default function TeamsTable({ teams, policies }) {
  const policyMap = Object.fromEntries((policies ?? []).map(p => [p.team_id, p]))

  if (!teams?.length) {
    return (
      <div className="bg-card border border-border rounded-xl shadow-card px-5 py-10 text-center text-muted text-sm">
        No requests this month yet.
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-xl shadow-card overflow-hidden">
      <div className="px-5 py-3.5 border-b border-border">
        <span className="text-xs font-semibold text-muted uppercase tracking-widest">
          Usage by team · current month
        </span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted uppercase tracking-widest bg-raised border-b border-border">
            <th className="px-5 py-3 text-left font-semibold">Team</th>
            <th className="px-5 py-3 text-right font-semibold">Requests</th>
            <th className="px-5 py-3 text-right font-semibold">Tokens</th>
            <th className="px-5 py-3 text-right font-semibold">Cost</th>
            <th className="px-5 py-3 text-left font-semibold w-44">Budget</th>
            <th className="px-5 py-3 text-left font-semibold">Policy</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {teams.map(team => {
            const policy = policyMap[team.team_id]
            const budget = parseFloat(policy?.monthly_budget_usd ?? team.team_budget ?? 0)
            const spent  = parseFloat(team.total_cost ?? 0)
            const pct    = budget > 0 ? (spent / budget) * 100 : 0

            return (
              <tr key={team.team_id} className="hover:bg-raised transition-colors">
                <td className="px-5 py-4">
                  <div className="font-semibold text-strong">{team.team_name}</div>
                  <div className="text-xs text-muted mt-0.5">
                    {team.active_users} member{team.active_users != 1 ? 's' : ''}
                  </div>
                </td>
                <td className="px-5 py-4 text-right text-strong tabular-nums font-mono text-sm">
                  {Number(team.total_requests).toLocaleString()}
                </td>
                <td className="px-5 py-4 text-right text-strong tabular-nums font-mono text-sm">
                  {formatTokens(team.total_tokens)}
                </td>
                <td className="px-5 py-4 text-right font-bold tabular-nums font-mono text-sm text-accent-text">
                  {formatCost(spent)}
                </td>
                <td className="px-5 py-4">
                  <div className="text-xs text-muted mb-1.5 tabular-nums">
                    {formatCost(spent)} / ${budget.toFixed(0)}
                  </div>
                  <ProgressBar pct={pct} />
                </td>
                <td className="px-5 py-4">
                  {policy
                    ? <span className="text-xs bg-accent-light text-accent-text font-medium rounded-full px-2.5 py-1">{policy.policy_name}</span>
                    : <span className="text-xs text-subtle">—</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
