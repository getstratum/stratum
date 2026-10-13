'use client'

import { useState, useEffect, useCallback } from 'react'
import Modal, { Field, Input, Select, Btn } from '../../components/Modal'
import { formatCost, formatTokens } from '../../lib/format'

function TeamModal({ team, policies, onSave, onClose }) {
  const [form, setForm] = useState({
    name:             team?.name             ?? '',
    policyId:         team?.policy_id        ?? '',
    monthlyBudgetUsd: team?.team_budget       ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function submit() {
    setSaving(true); setError('')
    try {
      const res  = await fetch(`/api/teams/${team.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:             form.name || undefined,
          policyId:         form.policyId || null,
          monthlyBudgetUsd: form.monthlyBudgetUsd ? parseFloat(form.monthlyBudgetUsd) : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Error saving'); return }
      onSave()
    } catch { setError('Connection error') }
    finally { setSaving(false) }
  }

  return (
    <Modal title={`Edit · ${team.name}`} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Team name">
          <Input value={form.name} onChange={e => set('name', e.target.value)} />
        </Field>
        <Field label="Policy" hint="Defines which models the team can use and their limits">
          <Select value={form.policyId} onChange={e => set('policyId', e.target.value)}>
            <option value="">No policy assigned</option>
            {policies.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Monthly budget override (USD)" hint="Leave empty to use the policy's budget">
          <Input
            type="number"
            step="0.01"
            placeholder="e.g. 500"
            value={form.monthlyBudgetUsd}
            onChange={e => set('monthlyBudgetUsd', e.target.value)}
          />
        </Field>

        {error && <p className="text-xs text-err">{error}</p>}
        <div className="flex gap-2 pt-1">
          <Btn variant="secondary" onClick={onClose} className="flex-1">Cancel</Btn>
          <Btn onClick={submit} disabled={saving} className="flex-1">
            {saving ? 'Saving…' : 'Save changes'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

export default function TeamsPage() {
  const [teams,    setTeams]    = useState([])
  const [policies, setPolicies] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [editing,  setEditing]  = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [t, p] = await Promise.all([
      fetch('/api/teams-detail').then(r => r.json()),
      fetch('/api/policies').then(r => r.json()),
    ])
    setTeams(t); setPolicies(p); setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) return <div className="p-7 text-center text-lo text-xs">Loading…</div>

  return (
    <div className="px-8 py-7 max-w-screen-xl space-y-4">
      <div>
        <h1 className="text-sm font-medium text-hi">Teams</h1>
        <p className="text-xs text-lo mt-0.5">{teams.length} teams configured</p>
      </div>

      {teams.map(team => {
        const budget = parseFloat(team.policy_budget ?? team.team_budget ?? 0)
        const spent  = parseFloat(team.cost_month ?? 0)
        const pct    = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0
        const warn   = pct >= 80

        return (
          <div key={team.id} className="bg-raised border border-line rounded-lg overflow-hidden">

            <div className="px-5 py-3.5 border-b border-line flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-xs font-medium text-hi">{team.name}</span>
                {team.department && (
                  <span className="text-2xs text-lo">{team.department}</span>
                )}
                {team.policy_name
                  ? <span className="text-2xs text-lo border border-line rounded px-2 py-0.5">{team.policy_name}</span>
                  : <span className="text-2xs text-warn border border-warn/20 rounded px-2 py-0.5 bg-warn/5">No policy assigned</span>
                }
              </div>
              <button
                onClick={() => setEditing(team)}
                className="text-2xs text-lo hover:text-mid transition-colors border border-line rounded px-2.5 py-1"
              >
                Edit
              </button>
            </div>

            <div className="p-5 grid grid-cols-2 lg:grid-cols-4 gap-5">
              <div>
                <div className="text-2xs text-lo mb-1">Requests this month</div>
                <div className="text-xl font-medium text-hi font-mono">{Number(team.requests_month).toLocaleString()}</div>
              </div>
              <div>
                <div className="text-2xs text-lo mb-1">Tokens consumed</div>
                <div className="text-xl font-medium text-hi font-mono">{formatTokens(team.tokens_month)}</div>
              </div>
              <div>
                <div className="text-2xs text-lo mb-1">Estimated cost</div>
                <div className={`text-xl font-medium font-mono ${warn ? 'text-err' : 'text-hi'}`}>
                  {formatCost(spent)}
                </div>
              </div>
              <div>
                <div className="text-2xs text-lo mb-1">Active members</div>
                <div className="text-xl font-medium text-hi font-mono">{team.total_users}</div>
              </div>
            </div>

            <div className="px-5 pb-4">
              <div className="flex justify-between text-2xs text-lo mb-1.5 font-mono tabular-nums">
                <span>Budget usage</span>
                <span className={warn ? 'text-err font-medium' : ''}>
                  {formatCost(spent)} / ${budget.toFixed(0)} ({pct.toFixed(0)}%)
                </span>
              </div>
              <div className="h-px bg-line rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${warn ? 'bg-err' : 'bg-accent'}`}
                  style={{ width: `${pct}%`, opacity: warn ? 1 : 0.4 }}
                />
              </div>
            </div>

            {team.allowed_models?.length > 0 && (
              <div className="px-5 pb-4 border-t border-line pt-4 flex flex-wrap gap-2">
                {team.allowed_models.map(m => (
                  <span key={m} className="text-2xs text-lo font-mono border border-line rounded px-2 py-0.5">
                    {m}
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {editing && (
        <TeamModal
          team={editing}
          policies={policies}
          onSave={() => { setEditing(null); load() }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
