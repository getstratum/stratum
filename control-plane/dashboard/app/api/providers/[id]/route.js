import { NextResponse } from 'next/server'
import { query }        from '../../../../lib/db'

export const dynamic = 'force-dynamic'

export async function PATCH(req, { params }) {
  try {
    const { id } = await params
    const body   = await req.json()
    const sets   = []
    const vals   = []
    let   idx    = 1

    const fields = { displayName: 'display_name', baseUrl: 'base_url', apiType: 'api_type',
                     apiKeyEnv: 'api_key_env', isActive: 'is_active', notes: 'notes' }

    for (const [key, col] of Object.entries(fields)) {
      if (body[key] !== undefined) { sets.push(`${col} = $${idx++}`); vals.push(body[key]) }
    }
    if ('apiKey' in body) { sets.push(`api_key = $${idx++}`); vals.push(body.apiKey || null) }

    if (sets.length) {
      vals.push(id)
      await query(`UPDATE providers SET ${sets.join(', ')} WHERE id = $${idx}`, vals)
    }

    if (body.addModel) {
      const m = body.addModel
      await query(
        `INSERT INTO ai_models (provider, model_id, display_name, cost_per_1k_input_tokens, cost_per_1k_output_tokens)
         SELECT slug, $2, $3, $4, $5 FROM providers WHERE id = $1 ON CONFLICT DO NOTHING`,
        [id, m.modelId, m.displayName, m.inputCost ?? 0, m.outputCost ?? 0]
      )
    }

    if (body.removeModelId) {
      await query(
        `DELETE FROM ai_models WHERE provider = (SELECT slug FROM providers WHERE id = $1) AND model_id = $2`,
        [id, body.removeModelId]
      )
    }

    const rows = await query(`
      SELECT p.id, p.slug, p.display_name, p.base_url, p.api_type,
             p.api_key_env, p.is_active, p.notes,
             (p.api_key IS NOT NULL) AS has_api_key,
             COALESCE(json_agg(json_build_object(
               'model_id', m.model_id, 'display_name', m.display_name,
               'input_cost', m.cost_per_1k_input_tokens::text,
               'output_cost', m.cost_per_1k_output_tokens::text
             ) ORDER BY m.display_name) FILTER (WHERE m.model_id IS NOT NULL), '[]') AS models
      FROM providers p LEFT JOIN ai_models m ON m.provider = p.slug
      WHERE p.id = $1 GROUP BY p.id`, [id])

    return NextResponse.json(rows[0])
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function DELETE(req, { params }) {
  try {
    await query('DELETE FROM providers WHERE id = $1', [(await params).id])
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
