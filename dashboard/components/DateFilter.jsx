'use client'

import { useState, useRef, useEffect } from 'react'

const QUICK = [
  { label: 'Este mes',        getValue: () => { const n = new Date(); return { period: `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}` } } },
  { label: 'Mes anterior',    getValue: () => { const n = new Date(new Date().getFullYear(), new Date().getMonth()-1, 1); return { period: `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}` } } },
  { label: 'Últimos 3 meses', getValue: () => { const n = new Date(); const f = new Date(n.getFullYear(), n.getMonth()-2, 1); return { from: f.toISOString().slice(0,10), to: n.toISOString().slice(0,10) } } },
  { label: 'Este año',        getValue: () => { const n = new Date(); return { from: `${n.getFullYear()}-01-01`, to: n.toISOString().slice(0,10) } } },
]

export default function DateFilter({ value, onChange }) {
  const [open,    setOpen]    = useState(false)
  const [custom,  setCustom]  = useState({ from: '', to: '' })
  const ref = useRef()

  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  function applyCustom() {
    if (custom.from && custom.to) {
      onChange({ from: custom.from, to: custom.to })
      setOpen(false)
    }
  }

  function label() {
    if (value.period) {
      const [y, m] = value.period.split('-')
      return new Date(y, m-1, 1).toLocaleDateString('es-UY', { month: 'long', year: 'numeric' })
    }
    if (value.from && value.to) return `${value.from} → ${value.to}`
    return 'Período'
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-sm border border-border rounded-lg px-3.5 py-2 bg-card hover:bg-raised transition-colors text-default font-medium shadow-sm"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-muted">
          <rect x="1" y="2" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
          <path d="M4 1v2M10 1v2M1 5.5h12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
        <span>{label()}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-subtle">
          <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-72 bg-card border border-border rounded-xl shadow-dropdown z-40 p-3">
          {/* Quick selectors */}
          <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2 px-1">Acceso rápido</div>
          <div className="grid grid-cols-2 gap-1 mb-3">
            {QUICK.map(q => (
              <button
                key={q.label}
                onClick={() => { onChange(q.getValue()); setOpen(false) }}
                className="text-xs text-left px-3 py-2 rounded-lg hover:bg-raised transition-colors text-default"
              >
                {q.label}
              </button>
            ))}
          </div>

          {/* Custom range */}
          <div className="border-t border-border pt-3">
            <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-2 px-1">Rango personalizado</div>
            <div className="flex gap-2 items-center">
              <input
                type="date"
                value={custom.from}
                onChange={e => setCustom(c => ({ ...c, from: e.target.value }))}
                className="flex-1 text-xs border border-border rounded-lg px-2.5 py-2 bg-raised text-default focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
              />
              <span className="text-subtle text-xs">→</span>
              <input
                type="date"
                value={custom.to}
                onChange={e => setCustom(c => ({ ...c, to: e.target.value }))}
                className="flex-1 text-xs border border-border rounded-lg px-2.5 py-2 bg-raised text-default focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
              />
            </div>
            <button
              onClick={applyCustom}
              disabled={!custom.from || !custom.to}
              className="w-full mt-2 bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-xs font-semibold rounded-lg py-2 transition-colors"
            >
              Aplicar rango
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
