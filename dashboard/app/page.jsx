'use client'

import { useState, useEffect, useCallback } from 'react'
import StatsCards  from '../components/StatsCards'
import DailyChart  from '../components/DailyChart'
import TeamsTable  from '../components/TeamsTable'
import RequestsLog from '../components/RequestsLog'
import DateFilter  from '../components/DateFilter'
import { ProviderChart, ModelChart } from '../components/AnalyticsCharts'

const TABS = [
  { id: 'general',   label: 'General' },
  { id: 'providers', label: 'Por proveedor' },
  { id: 'models',    label: 'Por modelo' },
]

function defaultPeriod() {
  const n = new Date()
  return { period: `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}` }
}

function buildQuery(range) {
  if (range.period) return `?period=${range.period}`
  if (range.from && range.to) return `?from=${range.from}&to=${range.to}`
  return ''
}

function periodLabel(range) {
  if (range.period) {
    const [y, m] = range.period.split('-')
    return new Date(y, m-1, 1).toLocaleDateString('es-UY', { month: 'long', year: 'numeric' })
  }
  if (range.from && range.to) return `${range.from} → ${range.to}`
  return ''
}

export default function OverviewPage() {
  const [tab,       setTab]       = useState('general')
  const [range,     setRange]     = useState(defaultPeriod)
  const [stats,     setStats]     = useState(null)
  const [analytics, setAnalytics] = useState(null)
  const [logs,      setLogs]      = useState([])
  const [loading,   setLoading]   = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const q = buildQuery(range)

    const [s, a, l] = await Promise.all([
      fetch(`/api/stats${q}`).then(r => r.json()),
      fetch(`/api/analytics${q}`).then(r => r.json()),
      fetch(`/api/logs-recent`).then(r => r.json()).catch(() => []),
    ])

    setStats(s)
    setAnalytics(a)
    setLogs(l)
    setLoading(false)
  }, [range])

  useEffect(() => { load() }, [load])

  return (
    <div className="px-8 py-6 max-w-screen-xl space-y-5">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-strong">Overview</h1>
          <p className="text-sm text-muted mt-0.5 capitalize">{periodLabel(range)}</p>
        </div>
        <DateFilter value={range} onChange={r => setRange(r)} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.id
                ? 'text-accent border-accent'
                : 'text-muted border-transparent hover:text-default'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="text-center text-muted text-sm py-16">Loading…</div>
      )}

      {!loading && stats && (

        <>
          {/* ── General tab ── */}
          {tab === 'general' && (
            <div className="space-y-5">
              <StatsCards stats={stats.totals} />

              <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
                <div className="lg:col-span-2">
                  <DailyChart data={stats.daily} />
                </div>
                <div className="lg:col-span-3">
                  <TeamsTable teams={stats.teams} policies={stats.teams} />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold text-muted uppercase tracking-widest">
                    Recent requests
                  </span>
                  <a href="/logs" className="text-xs text-accent hover:text-accent-hover font-medium">
                    View all →
                  </a>
                </div>
                <RequestsLog logs={logs} />
              </div>
            </div>
          )}

          {/* ── Providers tab ── */}
          {tab === 'providers' && (
            <ProviderChart data={analytics?.byProvider ?? []} />
          )}

          {/* ── Models tab ── */}
          {tab === 'models' && (
            <ModelChart data={analytics?.byModel ?? []} />
          )}
        </>
      )}
    </div>
  )
}
