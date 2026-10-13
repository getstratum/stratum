export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { query, getDb } from '../../../lib/db'

const DEMO_ORG = '00000000-0000-0000-0000-000000000001'

export async function GET() {
  const agents = await query(`
    SELECT
      a.id, a.name, a.description, a.api_key_prefix,
      a.is_active, a.created_at,
      a.default_model, a.default_provider,
      t.id   AS team_id,
      t.name AS team_name,
      p.name AS policy_name,
      COUNT(r.id)                                       AS requests_month,
      COALESCE(SUM(r.tokens_input + r.tokens_output),0) AS tokens_month,
      COALESCE(SUM(r.cost_usd), 0)                      AS cost_month
    FROM agents a
    LEFT JOIN teams t        ON t.id = a.team_id
    LEFT JOIN policies p     ON p.id = t.policy_id
    LEFT JOIN request_logs r ON r.agent_id = a.id
                             AND r.created_at >= date_trunc('month', NOW())
    WHERE a.org_id = $1
    GROUP BY a.id, a.name, a.description, a.api_key_prefix,
             a.is_active, a.created_at, t.id, t.name, p.name
    ORDER BY a.created_at DESC
  `, [DEMO_ORG])

  return NextResponse.json(agents)
}

export async function POST(req) {
  const { name, description, teamId, defaultModel, defaultProvider } = await req.json()

  if (!name?.trim()) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  }

  // Generate agent key with aig_agt_ prefix
  const rawKey    = `aig_agt_${crypto.randomBytes(24).toString('hex')}`
  const keyHash   = crypto.createHash('sha256').update(rawKey).digest('hex')
  const keyPrefix = rawKey.slice(0, 16) + '...'

  const db = getDb()
  const { rows } = await db.query(`
    INSERT INTO agents (org_id, team_id, name, description, api_key_hash, api_key_prefix, default_model, default_provider)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, name, description, api_key_prefix, is_active, created_at, default_model, default_provider
  `, [DEMO_ORG, teamId || null, name.trim(), description || null, keyHash, keyPrefix,
      defaultModel || null, defaultProvider || null])

  return NextResponse.json({ agent: rows[0], apiKey: rawKey }, { status: 201 })
}
