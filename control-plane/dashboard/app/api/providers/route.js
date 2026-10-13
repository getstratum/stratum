import { NextResponse } from 'next/server'
import { query }        from '../../../lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const rows = await query(`
      SELECT p.id, p.slug, p.display_name, p.base_url, p.api_type,
             p.api_key_env, p.is_active, p.notes,
             (p.api_key IS NOT NULL) AS has_api_key,
             COALESCE(
               json_agg(
                 json_build_object(
                   'model_id',     m.model_id,
                   'display_name', m.display_name,
                   'input_cost',   m.cost_per_1k_input_tokens::text,
                   'output_cost',  m.cost_per_1k_output_tokens::text
                 ) ORDER BY m.display_name
               ) FILTER (WHERE m.model_id IS NOT NULL), '[]'
             ) AS models
      FROM providers p
      LEFT JOIN ai_models m ON m.provider = p.slug
      GROUP BY p.id
      ORDER BY p.display_name
    `)
    return NextResponse.json(rows)
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function POST(req) {
  try {
    const { slug, displayName, baseUrl, apiType, apiKeyEnv, apiKey, isActive, notes, models } = await req.json()
    if (!slug || !displayName || !baseUrl || !apiType)
      return NextResponse.json({ error: 'slug, displayName, baseUrl and apiType are required' }, { status: 400 })

    const rows = await query(
      `INSERT INTO providers (slug, display_name, base_url, api_type, api_key_env, api_key, is_active, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, slug, display_name, base_url, api_type, api_key_env, is_active, notes`,
      [slug, displayName, baseUrl, apiType, apiKeyEnv ?? null, apiKey ?? null, isActive ?? false, notes ?? null]
    )
    const provider = rows[0]

    if (models?.length) {
      for (const m of models) {
        await query(
          `INSERT INTO ai_models (provider, model_id, display_name, cost_per_1k_input_tokens, cost_per_1k_output_tokens)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [slug, m.modelId, m.displayName, m.inputCost ?? 0, m.outputCost ?? 0]
        )
      }
    }
    return NextResponse.json({ ...provider, has_api_key: !!apiKey, models: models ?? [] })
  } catch (err) {
    if (err.code === '23505')
      return NextResponse.json({ error: 'A provider with this slug already exists' }, { status: 409 })
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
