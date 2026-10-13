export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { query, getDb } from '../../../lib/db'

const DEMO_ORG = '00000000-0000-0000-0000-000000000001'

export async function GET() {
  const alerts = await query(`
    SELECT
      a.id, a.alert_type, a.threshold_pct, a.channel,
      a.destination, a.is_active, a.last_fired_at, a.created_at,
      t.id   AS team_id,
      t.name AS team_name
    FROM alerts a
    JOIN teams t ON t.id = a.team_id
    WHERE a.org_id = $1
    ORDER BY t.name, a.alert_type
  `, [DEMO_ORG])

  return NextResponse.json(alerts)
}

export async function POST(req) {
  const { teamId, alertType, thresholdPct, channel, destination } = await req.json()

  if (!teamId || !alertType || !channel || !destination) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const db = getDb()
  const { rows } = await db.query(`
    INSERT INTO alerts (org_id, team_id, alert_type, threshold_pct, channel, destination)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [DEMO_ORG, teamId, alertType, thresholdPct ?? 80, channel, destination])

  return NextResponse.json(rows[0], { status: 201 })
}
