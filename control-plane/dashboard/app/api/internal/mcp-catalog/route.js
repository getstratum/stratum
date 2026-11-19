/**
 * POST /api/internal/mcp-catalog — a gateway reports the tools of each MCP
 * server of its organization (ADR-0016, from 0.9): it lists them with
 * tools/list, never a call; the console never reaches the servers.
 * Authenticated with the gateway's sync token, like /api/internal/sync.
 *
 * Body: { instance_id, servers: [{ name, tools: [{ name, description,
 *         read_only }], error }] }
 * 200:  { updated }: the servers of the organization it named
 * 400 / 413: not a report; 401: unknown or disabled gateway.
 */

import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { tokenRoute, HttpError } from '@/lib/route'
import { authenticateInstance } from '@/lib/instance-auth'
import { catalogReport, storeCatalog, CATALOG_MAX_BYTES } from '@/lib/mcp'

export const dynamic = 'force-dynamic'

const fail = (status, type, message) => NextResponse.json({ error: { type, message } }, { status })

export const POST = tokenRoute(async (req) => {
  const db = getDb()
  const instance = await authenticateInstance(db, req.headers.get('authorization'))
  if (!instance) return fail(401, 'authentication_error', 'Invalid or missing sync token.')
  const text = await req.text()
  if (Buffer.byteLength(text) > CATALOG_MAX_BYTES) return fail(413, 'too_large', `Reports are limited to ${CATALOG_MAX_BYTES} bytes.`)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return fail(400, 'invalid_json', 'The body is not JSON.')
  }
  if (body?.instance_id && body.instance_id !== instance.id) {
    return fail(403, 'permission_error', 'instance_id does not match the token.')
  }
  let servers
  try {
    servers = catalogReport(body)
  } catch (err) {
    if (err instanceof HttpError) return fail(400, 'invalid_report', err.message)
    throw err
  }
  return NextResponse.json({ updated: await storeCatalog(db, instance, servers) })
})
