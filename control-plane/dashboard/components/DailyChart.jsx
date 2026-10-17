'use client'

import Link from 'next/link'
import {
  ResponsiveContainer, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts'
import { formatCost } from '../lib/format'

// Requests per day, one series on one axis; the cost of each day is in the
// tooltip (two measures never share a chart with two scales).
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2.5 shadow-dropdown text-sm">
      <div className="text-muted mb-1 text-xs font-medium">{label}</div>
      <div className="text-strong font-semibold tabular">{(d.requests ?? 0).toLocaleString('es-UY')} requests</div>
      <div className="text-muted text-xs tabular">{formatCost(d.cost ?? 0)} estimado</div>
    </div>
  )
}

export default function DailyChart({ data }) {
  return (
    <div className="bg-card rounded-[10px] border border-border p-5 h-full">
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <h2 className="text-base font-semibold text-strong">Requests por día</h2>
        <Link href="/usage" className="text-[13px] text-accent hover:text-accent-hover">Ver consumo</Link>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={data} barCategoryGap="38%">
          <CartesianGrid vertical={false} stroke="#eef0f3" />
          <XAxis dataKey="day" tick={{ fill: '#6b7380', fontSize: 11 }} axisLine={{ stroke: '#c9ced6' }} tickLine={false} />
          <YAxis tick={{ fill: '#6b7380', fontSize: 11 }} axisLine={false} tickLine={false} width={36} allowDecimals={false} />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: '#eef0f3' }} />
          <Bar dataKey="requests" fill="#2a78d6" radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
