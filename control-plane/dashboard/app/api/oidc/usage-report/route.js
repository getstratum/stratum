// GET /api/oidc/usage-report?person=<id>&kind=scopes|self|team[&month=AAAA-MM]
//
// An application (client_id and secret, HTTP Basic) asks for a usage report
// on behalf of a person it signed in (lib/usage-report.js):
//
//   kind=scopes  which reports the person may have: { person, self, team }
//   kind=self    their own usage in the month
//   kind=team    their team's, added up, if they manage it
//
// The application has to be allowed to (Aplicaciones → "Reportes de
// consumo"). Every report given or refused is in the audit log.
export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getDb } from '../../../../lib/db.js'
import { isUuid, publicRoute } from '../../../../lib/route.js'
import { issuer, authenticateClient, clientCredentials } from '../../../../lib/oidc.js'
import { audit } from '../../../../lib/audit.js'
import { ReportError, reportScopes, usageReport } from '../../../../lib/usage-report.js'

const NO_STORE = { 'Cache-Control': 'no-store' }
const fail = (status, error, message, extra = {}) =>
  NextResponse.json({ error, message, ...extra }, { status, headers: NO_STORE })

export const GET = publicRoute(async (req) => {
  if (!issuer()) return fail(404, 'not_found', 'OIDC is off')
  const db = getDb()
  const creds = clientCredentials(req, new URLSearchParams())
  const client = await authenticateClient(db, creds.id, creds.secret)
  if (!client) {
    const res = fail(401, 'invalid_client', 'unknown client or wrong secret')
    res.headers.set('WWW-Authenticate', 'Basic realm="stratum"')
    return res
  }
  if (!client.usage_reports) {
    return fail(403, 'not_allowed', 'Esta aplicación no tiene habilitados los reportes de consumo (Aplicaciones, en la consola).')
  }

  const q = new URL(req.url).searchParams
  const person = q.get('person')
  const kind = q.get('kind') ?? 'self'
  if (!isUuid(person)) return fail(400, 'invalid_person', 'person tiene que ser el id de la persona.')

  if (kind === 'scopes') {
    const scopes = await reportScopes(db, client, person)
    if (!scopes) return fail(404, 'unknown_user', 'La persona no existe o no puede usar aplicaciones.')
    return NextResponse.json(scopes, { headers: NO_STORE })
  }

  const month = q.get('month')
  const record = (result, details) => audit(db, {
    req, orgId: client.org_id, actor: `app:${client.name}`, action: 'usage_report.read', result,
    targetType: kind === 'team' ? 'team' : 'user', targetId: person,
    details: { app: client.id, person, kind, month, ...details },
  })
  try {
    const report = await usageReport(db, client, { personId: person, kind, month })
    await record('ok', { requests: report.totals.requests })
    return NextResponse.json(report, { headers: NO_STORE })
  } catch (err) {
    if (!(err instanceof ReportError)) throw err
    if (err.status === 403) await record('denied', { reason: err.code })
    return fail(err.status, err.code, err.message, err.extra)
  }
})
