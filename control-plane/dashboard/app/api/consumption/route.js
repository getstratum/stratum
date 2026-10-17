export const dynamic = 'force-dynamic'
import { route, json } from '../../../lib/route.js'
import { parseDateRange } from '../../../lib/usage.js'
import { parseQuery, consumption } from '../../../lib/consumption.js'

// GET /api/consumption?by=team|agent|user|model|provider[&from&to|&period]
//                      [&team=|&agent=|&user=|&model=provider/model|&provider=]
//
// Consumption grouped by one dimension, optionally within one team, agent,
// person, model or provider (lib/consumption.js).
export const GET = route('usage.read', async (req, { session, db }) => {
  const params = new URL(req.url).searchParams
  const { from, to } = parseDateRange(params)
  const { by, filter } = parseQuery(params)
  return json(await consumption(db, session, { from, to, by, filter }))
})
