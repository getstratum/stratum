/**
 * lib/route.js — every console API route goes through one of these.
 *
 *   export const GET = route('users.read', async (req, { session, db, params }) => ...)
 *
 * route() checks, in this order: the request is not a cross-site browser
 * request (state-changing methods), there is a valid session (401), and the
 * session's role has the permission (403, recorded in the audit log). The
 * handler receives the session with `scope` set to what the role may reach
 * for that permission: 'org', 'team' or 'self' (lib/authz.js).
 *
 * publicRoute() and tokenRoute() mark the few routes that do not use a
 * console session. test/routes.test.mjs fails if a route file exports a
 * handler that went through none of the three.
 */

import { NextResponse } from 'next/server'
import { getDb } from './db.js'
import { COOKIE, loadSession } from './session.js'
import { scopeFor } from './authz.js'
import { audit } from './audit.js'

export const GUARD = Symbol.for('stratum.route.guard')

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code)
    this.status = status
    this.code = code
  }
}

export const badRequest = (message) => new HttpError(400, 'bad_request', message)
export const notFound   = (what = 'Not found') => new HttpError(404, 'not_found', what)
export const forbidden  = (message = 'No tenés permiso para esto.') => new HttpError(403, 'forbidden', message)
export const conflict   = (message) => new HttpError(409, 'conflict', message)

export const json = (body, status = 200) => NextResponse.json(body, { status })

/** The JSON body, or a 400. Arrays and scalars are refused. */
export async function readJson(req) {
  let body
  try {
    body = await req.json()
  } catch {
    throw badRequest('El cuerpo del pedido no es JSON válido.')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('El cuerpo del pedido tiene que ser un objeto JSON.')
  }
  return body
}

/**
 * Runs `fn(client)` in a transaction on one pooled connection.
 */
export async function withTransaction(db, fn) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

// Browsers send Origin (and Sec-Fetch-Site) with every fetch that can change
// state. A request from another site is refused even though the session
// cookie is SameSite=Lax. Clients that are not browsers send neither and are
// let through: they have to hold the cookie themselves.
function crossSite(req) {
  if (SAFE.has(req.method)) return false
  if (req.headers.get('sec-fetch-site') === 'cross-site') return true
  const origin = req.headers.get('origin')
  if (!origin) return false
  let originHost
  try {
    originHost = new URL(origin).host
  } catch {
    return true
  }
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
  return originHost !== host
}

function failure(err) {
  if (err instanceof HttpError) {
    return json({ error: err.code, message: err.message }, err.status)
  }
  console.error('[api]', err)
  return json({ error: 'internal_error', message: 'Error interno.' }, 500)
}

/**
 * @param {string} permission  a key of PERMISSIONS in lib/authz.js
 * @param {(req, ctx: {session, db, params}) => Promise<Response>} handler
 * @param {{duringEnrollment?: boolean}} options  duringEnrollment: also open
 *   to a session that must set up the second factor first (lib/mfa.js)
 */
export function route(permission, handler, { duringEnrollment = false } = {}) {
  scopeFor('owner', permission) // throws at import time on an unknown permission
  const wrapped = async (req, ctx) => {
    try {
      if (crossSite(req)) {
        return json({ error: 'forbidden', message: 'Pedido de otro sitio rechazado.' }, 403)
      }
      const db = getDb()
      const session = await loadSession(db, req.cookies?.get(COOKIE)?.value)
      if (!session) {
        return json({ error: 'unauthorized', message: 'Iniciá sesión.' }, 401)
      }
      if (session.enrollmentOnly && !duringEnrollment) {
        return json({ error: 'mfa_enrollment_required',
          message: 'Configurá la verificación en dos pasos para seguir: es obligatoria para tu rol.' }, 403)
      }
      const scope = scopeFor(session.role, permission)
      if (!scope) {
        await audit(db, {
          req, session, action: 'permission.denied', result: 'denied',
          details: { permission, method: req.method, path: new URL(req.url).pathname },
        })
        return json({ error: 'forbidden', message: 'Tu rol no tiene permiso para esto.' }, 403)
      }
      // A team scope without a team reaches nothing (and must not be read as
      // "the team of objects that have no team").
      if (scope === 'team' && !session.teamId) {
        await audit(db, {
          req, session, action: 'permission.denied', result: 'denied',
          details: { permission, method: req.method, path: new URL(req.url).pathname, reason: 'no_team' },
        })
        return json({ error: 'forbidden', message: 'Tu rol necesita un equipo asignado.' }, 403)
      }
      const params = ctx?.params ? await ctx.params : {}
      return await handler(req, { session: { ...session, scope }, db, params })
    } catch (err) {
      return failure(err)
    }
  }
  wrapped[GUARD] = { kind: 'session', permission, duringEnrollment }
  return wrapped
}

/** A route anyone may call (health check, sign-in). */
export function publicRoute(handler) {
  const wrapped = async (req, ctx) => {
    try {
      if (crossSite(req)) {
        return json({ error: 'forbidden', message: 'Pedido de otro sitio rechazado.' }, 403)
      }
      return await handler(req, ctx)
    } catch (err) {
      return failure(err)
    }
  }
  wrapped[GUARD] = { kind: 'public' }
  return wrapped
}

/** A route authenticated by a data plane sync token, checked by the handler. */
export function tokenRoute(handler) {
  const wrapped = async (req, ctx) => {
    try {
      return await handler(req, ctx)
    } catch (err) {
      return failure(err)
    }
  }
  wrapped[GUARD] = { kind: 'sync-token' }
  return wrapped
}

/**
 * Refuses (404, as if it did not exist) a team outside the session's reach:
 * another organization's, or, for a 'team' scope, any team but the user's own.
 * `teamId` null means "no team", which only an 'org' scope reaches.
 */
export async function assertTeamInScope(db, session, teamId) {
  if (teamId == null || teamId === '') {
    if (session.scope !== 'org') throw forbidden('Solo podés gestionar tu propio equipo.')
    return
  }
  if (!isUuid(teamId)) throw badRequest('Equipo inválido.')
  const { rows } = await db.query('SELECT 1 FROM teams WHERE id = $1 AND org_id = $2', [teamId, session.orgId])
  if (!rows[0]) throw notFound('Equipo no encontrado.')
  if (session.scope === 'team' && teamId !== session.teamId) {
    throw forbidden('Solo podés gestionar tu propio equipo.')
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v)

/** A UUID route parameter, or a 404 (a malformed id names nothing). */
export function idParam(params, name = 'id') {
  const v = params?.[name]
  if (!isUuid(v)) throw notFound()
  return v
}
