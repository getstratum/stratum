export const dynamic = 'force-dynamic'
import { route, json } from '../../../lib/route.js'
import { parseDateRange } from '../../../lib/usage.js'
import { parseQuery, consumption } from '../../../lib/consumption.js'

// GET /api/consumption?by=team|agent|app|user|model|provider|label[&from&to|&period]
//                      [&team=|&agent=|&app=|&user=|&model=provider/model|&provider=|&label=]
//
// Consumption grouped by one dimension, optionally within one team, agent,
// application, person, model, provider or label (lib/consumption.js).
export const GET = route('usage.read', async (req, { session, db }) => {
  const params = new URL(req.url).searchParams
  const { from, to } = parseDateRange(params)
  const { by, filter } = parseQuery(params)
  return json(await consumption(db, session, { from, to, by, filter }))
})
