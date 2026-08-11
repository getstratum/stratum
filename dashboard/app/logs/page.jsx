'use client'

import { useState, useEffect, useCallback } from 'react'
import RequestsLog from '../../components/RequestsLog'
import DateFilter  from '../../components/DateFilter'
import { toCSV, downloadCSV, LOG_COLUMNS } from '../../lib/csv'

const STATUS_OPTIONS = [
  { value: '',        label: 'All statuses' },
  { value: 'success', label: 'Success (2xx)' },
  { value: 'error',   label: 'Error (4xx/5xx)' },
]

const LIMIT_OPTIONS = [50, 100, 200, 500]

function defaultPeriod() {
  const n = new Date()
  return { period: `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}` }
}

function buildQuery(filters) {
  const p = new URLSearchParams()
  if (filters.range.period)         p.set('period',   filters.range.period)
  if (filters.range.from)           p.set('from',     filters.range.from)
  if (filters.range.to)             p.set('to',       filters.range.to)
  if (filters.team)                 p.set('team',     filters.team)
  if (filters.provider)             p.set('provider', filters.provider)
  if (filters.model)                p.set('model',    filters.model)
  if (filters.status)               p.set('status',   filters.status)
  p.set('limit', filters.limit)
  return `?${p.toString()}`
}

export default function LogsPage() {
  const [logs,      setLogs]      = useState([])
  const [teams,     setTeams]     = useState([])
  const [providers, setProviders] = useState([])
  const [loading,   setLoading]   = useState(true)

  const [filters, setFilters] = useState({
    range:    defaultPeriod(),
    team:     '',
    provider: '',
    model:    '',
    status:   '',
    limit:    100,
  })

  const [modelInput, setModelInput] = useState('')
  const [modelTimer, setModelTimer] = useState(null)

  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }))

  const load = useCallback(async () => {
    setLoading(true)
    const data = await fetch(`/api/logs${buildQuery(filters)}`).then(r => r.json())
    setLogs(data)
    setLoading(false)
  }, [filters])

  useEffect(() => { load() }, [load])

  // Load filter options once
  useEffect(() => {
    Promise.all([
      fetch('/api/teams').then(r => r.json()),
      fetch('/api/providers').then(r => r.json()),
    ]).then(([t, p]) => {
      setTeams(t)
      setProviders(p.filter(p => p.is_active))
    })
  }, [])

  // Debounce model text filter
  function handleModelInput(v) {
    setModelInput(v)
    clearTimeout(modelTimer)
    setModelTimer(setTimeout(() => setFilter('model', v), 400))
  }

  function handleExport() {
    const csv = toCSV(logs, LOG_COLUMNS)
    const ts  = new Date().toISOString().slice(0, 10)
    downloadCSV(csv, `proxima-logs-${ts}.csv`)
  }

  const hasFilters = filters.team || filters.provider || filters.model || filters.status

  return (
    <div className="px-8 py-6 max-w-screen-xl space-y-5">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-strong">Requests</h1>
          <p className="text-sm text-muted mt-0.5">
            {loading ? 'Loading…' : `${logs.length} results`}
            {hasFilters && <span className="text-accent-text font-medium ml-1">· filtered</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DateFilter value={filters.range} onChange={r => setFilter('range', r)} />
          <button
            onClick={handleExport}
            disabled={!logs.length}
            className="flex items-center gap-1.5 text-sm border border-border rounded-lg px-3.5 py-2 bg-card hover:bg-raised transition-colors text-muted font-medium shadow-sm disabled:opacity-40"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M6.5 1v8M3.5 6l3 3 3-3M1 10.5h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Export CSV
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="bg-card border border-border rounded-xl shadow-card p-4">
        <div className="flex flex-wrap gap-3 items-end">

          {/* Team */}
          <div className="flex-1 min-w-36">
            <label className="block text-xs text-muted mb-1.5 font-medium">Team</label>
            <select
              value={filters.team}
              onChange={e => setFilter('team', e.target.value)}
              className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-raised text-default focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
            >
              <option value="">All teams</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>

          {/* Provider */}
          <div className="flex-1 min-w-36">
            <label className="block text-xs text-muted mb-1.5 font-medium">Provider</label>
            <select
              value={filters.provider}
              onChange={e => setFilter('provider', e.target.value)}
              className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-raised text-default focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
            >
              <option value="">All providers</option>
              {providers.map(p => <option key={p.slug} value={p.slug}>{p.display_name}</option>)}
            </select>
          </div>

          {/* Model */}
          <div className="flex-1 min-w-36">
            <label className="block text-xs text-muted mb-1.5 font-medium">Model</label>
            <input
              type="text"
              placeholder="Search model…"
              value={modelInput}
              onChange={e => handleModelInput(e.target.value)}
              className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-raised text-default focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20 placeholder-subtle"
            />
          </div>

          {/* Status */}
          <div className="flex-1 min-w-36">
            <label className="block text-xs text-muted mb-1.5 font-medium">Status</label>
            <select
              value={filters.status}
              onChange={e => setFilter('status', e.target.value)}
              className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-raised text-default focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
            >
              {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>

          {/* Limit */}
          <div className="w-28">
            <label className="block text-xs text-muted mb-1.5 font-medium">Show</label>
            <select
              value={filters.limit}
              onChange={e => setFilter('limit', parseInt(e.target.value))}
              className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-raised text-default focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
            >
              {LIMIT_OPTIONS.map(n => <option key={n} value={n}>{n} rows</option>)}
            </select>
          </div>

          {/* Clear filters */}
          {hasFilters && (
            <button
              onClick={() => {
                setFilters(f => ({ ...f, team: '', provider: '', model: '', status: '' }))
                setModelInput('')
              }}
              className="text-xs text-muted hover:text-err transition-colors pb-0.5"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      <RequestsLog logs={logs} />
    </div>
  )
}
