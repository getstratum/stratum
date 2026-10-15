export const dynamic = 'force-dynamic'
import { route, json } from '../../../lib/route.js'

// The model catalog is shared by every organization (prices, no secrets).
export const GET = route('models.read', async (req, { db }) => {
  const { rows } = await db.query(`
    SELECT provider, model_id, display_name,
           cost_per_1k_input_tokens, cost_per_1k_output_tokens
      FROM ai_models
     WHERE is_active = true
     ORDER BY provider, display_name
  `)
  return json(rows)
})
