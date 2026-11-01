// An application that keeps people's conversations (client_id and secret,
// HTTP Basic) asks, on behalf of a person it signed in (lib/history-audit.js):
//
//   GET  ?person=<id>&kind=roles                 { person, audit, approve }
//   GET  ?person=<id>&kind=people&q=<text>       { people: [{ id, name, email, active }] }
//   GET  ?person=<id>&kind=subject&subject=<id>  { id, name, email, active }
//   POST { person, action, subject, details }    records it in the audit log
//
// action: history.request | history.approve | history.deny |
// history.revoke | history.read. The application has to be allowed to
// (Aplicaciones → "Auditoría de conversaciones").
export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getDb } from '../../../../lib/db.js'
import { publicRoute } from '../../../../lib/route.js'
import { issuer, authenticateClient, clientCredentials } from '../../../../lib/oidc.js'
import { AuditError, auditRoles, findPeople, recordAction, subjectFor } from '../../../../lib/history-audit.js'

const NO_STORE = { 'Cache-Control': 'no-store' }
const fail = (status, error, message) => NextResponse.json({ error, message }, { status, headers: NO_STORE })

async function client(req, db) {
  if (!issuer()) return { res: fail(404, 'not_found', 'OIDC is off') }
  const creds = clientCredentials(req, new URLSearchParams())
  const c = await authenticateClient(db, creds.id, creds.secret)
  if (!c) {
    const res = fail(401, 'invalid_client', 'unknown client or wrong secret')
    res.headers.set('WWW-Authenticate', 'Basic realm="stratum"')
    return { res }
  }
  if (!c.history_audit) {
    return { res: fail(403, 'not_allowed', 'Esta aplicación no tiene habilitada la auditoría de conversaciones (Aplicaciones, en la consola).') }
  }
  return { client: c }
}

const answer = async (fn) => {
  try {
    return NextResponse.json(await fn(), { headers: NO_STORE })
  } catch (err) {
    if (err instanceof AuditError) return fail(err.status, err.code, err.message)
    throw err
  }
}

export const GET = publicRoute(async (req) => {
  const db = getDb()
  const { client: c, res } = await client(req, db)
  if (res) return res
  const q = new URL(req.url).searchParams
  const person = q.get('person')
  switch (q.get('kind') ?? 'roles') {
    case 'roles':   return answer(() => auditRoles(db, c, person))
    case 'people':  return answer(async () => ({ people: await findPeople(db, c, person, q.get('q')) }))
    case 'subject': return answer(() => subjectFor(db, c, person, q.get('subject')))
    default:        return fail(400, 'invalid_kind', 'kind tiene que ser roles, people o subject.')
  }
})

export const POST = publicRoute(async (req) => {
  const db = getDb()
  const { client: c, res } = await client(req, db)
  if (res) return res
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return fail(400, 'invalid_body', 'El cuerpo tiene que ser JSON.')
  return answer(async () => ({ recorded: await recordAction(db, c, body, req) }))
})
