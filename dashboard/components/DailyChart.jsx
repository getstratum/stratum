'use client'

import {
  ResponsiveContainer, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts'
import { formatCost } from '../lib/format'

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2.5 shadow-dropdown text-sm">
      <div className="text-muted mb-1.5 text-xs font-medium">{label}</div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-sm bg-accent inline-block" />
          <span className="text-strong font-semibold">{payload[0]?.value ?? 0} requests</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-sm bg-accent/40 inline-block" />
          <span className="text-muted">{formatCost(payload[1]?.value ?? 0)}</span>
        </div>
      </div>
    </div>
  )
}

export default function DailyChart({ data }) {
  return (
    <div className="bg-card rounded-xl border border-border shadow-card p-5 h-full">
      <div className="text-xs font-semibold text-muted uppercase tracking-widest mb-5">
        Activity — last 7 days
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={data} barGap={3} barCategoryGap="38%">
          <CartesianGrid vertical={false} stroke="#f3f4f6" />
          <XAxis
            dataKey="day"
            tick={{ fill: '#9ca3af', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            yAxisId="req"
            tick={{ fill: '#9ca3af', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={30}
          />
          <YAxis
            yAxisId="cost"
            orientation="right"
            tick={{ fill: '#9ca3af', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={v => formatCost(v)}
            width={72}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: '#f3f4f6' }} />
          <Bar yAxisId="req"  dataKey="requests" fill="#7c3aed" radius={[4,4,0,0]} />
          <Bar yAxisId="cost" dataKey="cost"     fill="#7c3aed" radius={[4,4,0,0]} opacity={0.3} />
        </BarChart>
      </ResponsiveContainer>
      <div className="flex gap-5 mt-3">
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <span className="w-2.5 h-2 rounded-sm bg-accent inline-block"/>
          Requests
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <span className="w-2.5 h-2 rounded-sm bg-accent/30 inline-block"/>
          Cost
        </span>
      </div>
    </div>
  )
}
