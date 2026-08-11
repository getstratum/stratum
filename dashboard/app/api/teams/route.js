export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { query } from '../../../lib/db'

const DEMO_ORG = '00000000-0000-0000-0000-000000000001'

export async function GET() {
  const teams = await query(
    `SELECT t.id, t.name, t.department,
            p.name AS policy_name, p.allowed_models
     FROM teams t
     LEFT JOIN policies p ON p.id = t.policy_id
     WHERE t.org_id = $1
     ORDER BY t.name`,
    [DEMO_ORG]
  )
  return NextResponse.json(teams)
}
