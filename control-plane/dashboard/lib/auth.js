/**
 * lib/auth.js — Dashboard authentication helper
 *
 * requireAuth(request) → { id, email, teamName, team_id, org_id } | null
 *
 * Reads the stratum_session JWT cookie (same secret as middleware.js),
 * then looks up org_id from the DB. Used by routes that need dashboard
 * user auth (e.g. /api/internal/instances) instead of sync_token auth.
 */

import { jwtVerify } from 'jose'
import { query }     from './db.js'
import { getSessionSecret } from './secret.js'

function getSecret() {
  return getSessionSecret()
}

export async function requireAuth(request) {
  const sessionCookie = request.cookies?.get
    ? request.cookies.get('stratum_session')?.value
    : null

  if (!sessionCookie) return null

  try {
    const { payload } = await jwtVerify(sessionCookie, getSecret())
    if (!payload.email) return null

    // Look up org_id via the user → team relationship
    const rows = await query(
      `SELECT u.id, u.email, u.team_id, t.org_id
       FROM users u
       JOIN teams t ON t.id = u.team_id
       WHERE u.email = $1
       LIMIT 1`,
      [payload.email]
    )

    if (!rows[0]) return null
    return {
      id:       rows[0].id,
      email:    rows[0].email,
      teamName: payload.teamName ?? '',
      team_id:  rows[0].team_id,
      org_id:   rows[0].org_id,
    }
  } catch {
    return null
  }
}
