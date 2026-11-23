/**
 * Each organization's usage in a month, for billing (ADR-0020). Platform
 * token only.
 *
 * GET /api/platform/usage?month=YYYY-MM[&format=csv]
 *
 * month: a UTC month, the current one by default. Tokens, estimated cost
 * (the organization's own prices, or the catalog's) and requests come from
 * the month's usage per team, which retention never deletes; people,
 * agents, teams and gateways are what each organization has now.
 */
export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { platformRoute, json } from '@/lib/route'
import { usageByMonth } from '@/lib/org-admin'

const COLUMNS = ['month', 'id', 'name', 'status', 'plan', 'tokens', 'cost_usd', 'requests', 'people', 'agents', 'teams', 'gateways']

// A cell a spreadsheet would run as a formula starts with an apostrophe.
function cell(v) {
  let s = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const GET = platformRoute(async (req, { db }) => {
  const q = new URL(req.url).searchParams
  const month = q.get('month') || new Date().toISOString().slice(0, 7)
  const rows = await usageByMonth(db, month)
  if (q.get('format') !== 'csv') return json({ month, organizations: rows })
  const csv = [COLUMNS.join(','), ...rows.map(r => COLUMNS.map(c => cell(r[c])).join(','))].join('\r\n') + '\r\n'
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="stratum-usage-${month}.csv"`,
    },
  })
})
