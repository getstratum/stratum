'use client'

import { useState, useEffect, useCallback } from 'react'
import Modal, { Field, Input, Select, Btn } from '../../components/Modal'
import { formatCost, formatTokens } from '../../lib/format'

// ─── One-time key reveal ──────────────────────────────────────────────────────
function KeyReveal({ apiKey, onClose }) {
  const [copied, setCopied] = useState(false)
  return (
    <Modal title="Agent key generated" onClose={onClose} width="max-w-md">
      <div className="space-y-4">
        <p className="text-xs text-lo">
          This is the only time this key will be shown. Copy it now and store it securely.
        </p>
        <div className="flex gap-2">
          <code className="flex-1 bg-canvas border border-line rounded px-3 py-2 text-xs text-ok font-mono break-all">
            {apiKey}
          </code>
          <button
            onClick={() => { navigator.clipboard.writeText(apiKey); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
            className="flex-shrink-0 bg-overlay border border-line rounded px-3 py-2 text-xs text-hi transition-colors"
          >
            {copied ? '✓' : 'Copy'}
          </button>
        </div>
        <div className="bg-raised border border-line rounded p-3 text-2xs text-lo space-y-1">
          <div>Use this key in your agent's configuration:</div>
          <code className="text-mid">Authorization: Bearer {apiKey.slice(0, 20)}...</code>
        </div>
        <Btn variant="secondary" onClick={onClose} className="w-full">
          I've saved it, close
        </Btn>
      </div>
    </Modal>
  )
}

// ─── Create / Edit modal ──────────────────────────────────────────────────────
function AgentModal({ agent, teams, models, onSave, onClose }) {
  const isEdit = !!agent
  const [form, setForm] = useState({
    name:            agent?.name             ?? '',
    description:     agent?.description      ?? '',
    teamId:          agent?.team_id          ?? '',
    defaultModel:    agent?.default_model    ?? '',
    defaultProvider: agent?.default_provider ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function submit() {
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true); setError('')
    try {
      const res  = await fetch(
        isEdit ? `/api/agents/${agent.id}` : '/api/agents',
        {
          method:  isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
              ...form,
              defaultModel:    form.defaultModel    || null,
              defaultProvider: form.defaultProvider || null,
            }),
        }
      )
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Error saving'); return }
      onSave(data)
    } catch { setError('Connection error') }
    finally { setSaving(false) }
  }

  return (
    <Modal title={isEdit ? 'Edit agent' : 'New agent'} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Name *">
          <Input
            placeholder="e.g. Customer Support Bot"
            value={form.name}
            onChange={e => set('name', e.target.value)}
            autoFocus
          />
        </Field>
        <Field label="Description" hint="What does this agent do?">
          <Input
            placeholder="Handles tier-1 support tickets via Zendesk"
            value={form.description}
            onChange={e => set('description', e.target.value)}
          />
        </Field>
        <Field label="Team" hint="The agent inherits the team's policy">
          <Select
            value={form.teamId}
            onChange={e => {
              // Reset model when team changes — the new team may have different allowed models
              set('teamId', e.target.value)
              set('defaultModel', '')
              set('defaultProvider', '')
            }}
          >
            <option value="">No team</option>
            {teams.map(t => (
              <option key={t.id} value={t.id}>
                {t.name} {t.policy_name ? `· ${t.policy_name}` : ''}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Model"
          hint="Stratum always injects this model, overriding whatever the agent sends"
        >
          {(() => {
            // Filter models to only those allowed by the selected team's policy
            const selectedTeam   = teams.find(t => t.id === form.teamId)
            const allowedIds     = selectedTeam?.allowed_models ?? []
            const availableModels = allowedIds.length > 0
              ? models.filter(m => allowedIds.includes(m.model_id))
              : models

            return (
              <>
                <Select
                  value={form.defaultModel}
                  disabled={!form.teamId}
                  onChange={e => {
                    const m = models.find(x => x.model_id === e.target.value)
                    set('defaultModel',    e.target.value)
                    set('defaultProvider', m?.provider ?? '')
                  }}
                >
                  <option value="">
                    {!form.teamId
                      ? 'Select a team first'
                      : 'No model configured (agent must specify)'}
                  </option>
                  {availableModels.map(m => (
                    <option key={m.model_id} value={m.model_id}>
                      {m.display_name} · {m.provider}
                    </option>
                  ))}
                </Select>
                {form.teamId && availableModels.length === 0 && (
                  <p className="text-2xs text-warn mt-1">
                    This team's policy has no models configured yet.
                  </p>
                )}
                {form.defaultModel && (
                  <div className="text-2xs text-lo mt-1 font-mono">
                    Agents can call{' '}
                    <code className="text-mid">/proxy/auto/v1/chat/completions</code>
                    {' '}— no model or provider needed in their code.
                  </div>
                )}
              </>
            )
          })()}
        </Field>

        {!isEdit && (
          <div className="bg-raised border border-line rounded p-3 text-2xs text-lo">
            An API key with prefix <code className="text-mid font-mono">aig_agt_</code> will be generated.
            It will be shown once after creation.
          </div>
        )}

        {error && <p className="text-xs text-err">{error}</p>}

        <div className="flex gap-2 pt-1">
          <Btn variant="secondary" onClick={onClose} className="flex-1">Cancel</Btn>
          <Btn onClick={submit} disabled={saving} className="flex-1">
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create agent'}
          </Btn>
        </div>
      </div>
    </Modal>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function AgentsPage() {
  const [agents,    setAgents]    = useState([])
  const [teams,     setTeams]     = useState([])
  const [loading,   setLoading]   = useState(true)
  const [modal,     setModal]     = useState(null)
  const [revealKey, setRevealKey] = useState(null)
  const [rotating,  setRotating]  = useState(null)

  const [models, setModels] = useState([])

  const load = useCallback(async () => {
    setLoading(true)
    const [a, t, m] = await Promise.all([
      fetch('/api/agents').then(r => r.json()),
      fetch('/api/teams').then(r => r.json()),
      fetch('/api/models').then(r => r.json()),
    ])
    setAgents(a); setTeams(t); setModels(m); setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function toggleActive(agent) {
    await fetch(`/api/agents/${agent.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !agent.is_active }),
    })
    load()
  }

  async function rotateKey(agent) {
    setRotating(agent.id)
    const res  = await fetch(`/api/agents/${agent.id}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rotate-key' }),
    })
    const data = await res.json()
    setRotating(null)
    if (data.apiKey) setRevealKey(data.apiKey)
  }

  function handleSave(data) {
    setModal(null)
    if (data.apiKey) setRevealKey(data.apiKey)
    load()
  }

  return (
    <div className="px-8 py-7 max-w-screen-xl">

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-sm font-medium text-hi">Agents</h1>
          <p className="text-xs text-lo mt-0.5">
            Automated processes with dedicated keys and separate metrics
          </p>
        </div>
        <Btn onClick={() => setModal('create')}>+ New agent</Btn>
      </div>

      {/* Empty state */}
      {!loading && agents.length === 0 && (
        <div className="bg-raised border border-line rounded-lg px-8 py-16 text-center">
          <div className="text-xs text-lo mb-1">No agents configured</div>
          <div className="text-2xs text-lo opacity-60">
            Agents are automated processes (bots, pipelines, workflows) that call the AI gateway
            with their own key and appear separately in usage reports.
          </div>
        </div>
      )}

      {/* Agent list */}
      {!loading && agents.length > 0 && (
        <div className="space-y-3">
          {agents.map(agent => (
            <div
              key={agent.id}
              className={`bg-raised border border-line rounded-lg overflow-hidden ${!agent.is_active ? 'opacity-50' : ''}`}
            >
              <div className="px-5 py-3.5 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div>
                    <div className="text-xs font-medium text-hi">{agent.name}</div>
                    {agent.description && (
                      <div className="text-2xs text-lo mt-0.5">{agent.description}</div>
                    )}
                  </div>
                  {/* Team tag */}
                  {agent.team_name && (
                    <span className="text-2xs text-lo border border-line rounded px-2 py-0.5">
                      {agent.team_name}
                    </span>
                  )}
                  {agent.default_model && (
                    <span className="text-2xs font-mono text-mid border border-line rounded px-2 py-0.5">
                      {agent.default_model}
                    </span>
                  )}
                  {!agent.default_model && (
                    <span className="text-2xs text-lo opacity-40">no model configured</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setModal({ agent })}
                    className="text-2xs text-lo hover:text-mid transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => rotateKey(agent)}
                    disabled={rotating === agent.id}
                    className="text-2xs text-lo hover:text-mid transition-colors disabled:opacity-30"
                  >
                    {rotating === agent.id ? '…' : 'Rotate key'}
                  </button>
                  <button
                    onClick={() => toggleActive(agent)}
                    className={`text-2xs transition-colors ${agent.is_active ? 'text-lo hover:text-err' : 'text-lo hover:text-ok'}`}
                  >
                    {agent.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              </div>

              {/* Metrics row */}
              <div className="px-5 py-3 border-t border-line grid grid-cols-4 gap-5">
                <div>
                  <div className="text-2xs text-lo mb-1">Requests · month</div>
                  <div className="text-xs text-hi font-mono tabular-nums">
                    {Number(agent.requests_month).toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-2xs text-lo mb-1">Tokens</div>
                  <div className="text-xs text-hi font-mono tabular-nums">
                    {formatTokens(agent.tokens_month)}
                  </div>
                </div>
                <div>
                  <div className="text-2xs text-lo mb-1">Cost</div>
                  <div className="text-xs text-hi font-mono tabular-nums">
                    {formatCost(agent.cost_month)}
                  </div>
                </div>
                <div>
                  <div className="text-2xs text-lo mb-1">API key prefix</div>
                  <div className="text-xs text-lo font-mono">
                    {agent.api_key_prefix ?? '—'}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* How it works */}
      <div className="mt-8 bg-raised border border-line rounded-lg p-5">
        <div className="text-2xs text-lo uppercase tracking-widest font-medium mb-3">How agents work</div>
        <div className="grid grid-cols-3 gap-5 text-2xs text-lo">
          <div>
            <div className="text-mid mb-1">1. Create an agent</div>
            A key with prefix <code className="text-mid font-mono">aig_agt_</code> is generated.
            The agent inherits the team's policy — same model whitelist and quotas.
          </div>
          <div>
            <div className="text-mid mb-1">2. Configure your agent</div>
            Set the API key in your agent's environment and point the base URL to the gateway.
            No code changes needed if you're already using OpenAI/Anthropic SDKs.
          </div>
          <div>
            <div className="text-mid mb-1">3. Monitor separately</div>
            All requests from agents are tagged with <code className="text-mid font-mono">agent_id</code> in
            the logs. Usage appears here independently from human traffic.
          </div>
        </div>
      </div>

      {modal === 'create' && <AgentModal teams={teams} models={models} onSave={handleSave} onClose={() => setModal(null)} />}
      {modal?.agent && <AgentModal agent={modal.agent} teams={teams} models={models} onSave={handleSave} onClose={() => setModal(null)} />}
      {revealKey && <KeyReveal apiKey={revealKey} onClose={() => setRevealKey(null)} />}
    </div>
  )
}
