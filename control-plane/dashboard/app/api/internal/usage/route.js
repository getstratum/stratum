/**
 * POST /api/internal/usage — gateways report what each request consumed
 * (ADR-0009, contract in api/usage/v1). Authenticated with the gateway's
 * sync token, like /api/internal/sync.
 *
 * Body: { instance_id, records: [ ... up to 500 ... ] }
 * 200:  { accepted, duplicates, rejected }
 *       accepted   new records stored
 *       duplicates records already stored (a retried batch)
 *       rejected   records that cannot be stored (malformed, too old); the
 *                  gateway does not send them again
 * 400 / 413: the batch itself is malformed or too large; the gateway drops it.
 * 401: unknown or disabled gateway; the gateway keeps the batch and retries.
 *
 * Never carries prompts, completions or credentials.
 */

import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { tokenRoute } from '@/lib/route'
import { authenticateInstance } from '@/lib/instance-auth'
import { ingest, normalizeRecord, MAX_RECORDS, MAX_BODY_BYTES } from '@/lib/usage-ingest'

export const dynamic = 'force-dynamic'

const fail = (status, type, message) => NextResponse.json({ error: { type, message } }, { status })

export const POST = tokenRoute(async (req) => {
  const db = getDb()
  const instance = await authenticateInstance(db, req.headers.get('authorization'))
  if (!instance) return fail(401, 'authentication_error', 'Invalid or missing sync token.')

  const length = Number(req.headers.get('content-length') ?? 0)
  if (length > MAX_BODY_BYTES) return fail(413, 'too_large', `Batches are limited to ${MAX_BODY_BYTES} bytes.`)
  const text = await req.text()
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return fail(413, 'too_large', `Batches are limited to ${MAX_BODY_BYTES} bytes.`)

  let body
  try {
    body = JSON.parse(text)
  } catch {
    return fail(400, 'invalid_json', 'The body is not JSON.')
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.records)) {
    return fail(400, 'invalid_batch', 'Expected { instance_id, records: [...] }.')
  }
  if (body.instance_id && body.instance_id !== instance.id) {
    return fail(403, 'permission_error', 'instance_id does not match the token.')
  }
  if (body.records.length > MAX_RECORDS) {
    return fail(413, 'too_large', `Batches are limited to ${MAX_RECORDS} records.`)
  }

  const now = Date.now()
  const valid = body.records.map(r => normalizeRecord(r, now)).filter(Boolean)
  const rejected = body.records.length - valid.length
  if (rejected) console.warn(`[usage] ${instance.id}: ${rejected} of ${body.records.length} records rejected`)

  const accepted = await ingest(db, instance, valid)
  return NextResponse.json({ accepted, duplicates: valid.length - accepted, rejected })
})
