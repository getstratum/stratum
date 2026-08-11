export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { query } from '../../../lib/db'

export async function GET() {
  const models = await query(`
    SELECT provider, model_id, display_name,
           cost_per_1k_input_tokens, cost_per_1k_output_tokens
    FROM ai_models
    WHERE is_active = true
    ORDER BY provider, display_name
  `)
  return NextResponse.json(models)
}
