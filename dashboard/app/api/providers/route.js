export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { query, getDb } from '../../../lib/db'

export async function GET() {
  const providers = await query(`
    SELECT id, slug, display_name, base_url, api_type,
           api_key_env, auth_header, is_active, notes, created_at
    FROM providers
    ORDER BY is_active DESC, created_at
  `)
  return NextResponse.json(providers)
}

export async function POST(req) {
  const { slug, displayName, baseUrl, apiType, apiKeyEnv, authHeader, notes } = await req.json()

  if (!slug || !displayName || !baseUrl || !apiKeyEnv) {
    return NextResponse.json({ error: 'Required: slug, displayName, baseUrl, apiKeyEnv' }, { status: 400 })
  }

  const db = getDb()
  const { rows } = await db.query(`
    INSERT INTO providers (slug, display_name, base_url, api_type, api_key_env, auth_header, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (slug) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      base_url     = EXCLUDED.base_url,
      api_type     = EXCLUDED.api_type,
      api_key_env  = EXCLUDED.api_key_env,
      auth_header  = EXCLUDED.auth_header,
      notes        = EXCLUDED.notes
    RETURNING *
  `, [slug, displayName, baseUrl, apiType ?? 'openai-compatible', apiKeyEnv, authHeader ?? null, notes ?? null])

  return NextResponse.json(rows[0], { status: 201 })
}
