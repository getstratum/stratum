import crypto from 'crypto'
import { jwtVerify } from 'jose'
import { JWT_SECRET } from './login.js'

/**
 * Auth hook — three token types, same pipeline endpoint:
 *
 *   aig_sk_...   API key (developer)   → SHA-256 hash → users table
 *   aig_agt_...  Agent key             → SHA-256 hash → agents table
 *   xxx.yyy.zzz  Session JWT           → jwtVerify    → users table
 *
 * All resolve to: { user|agent, team, policy } on request.ctx
 */

export async function authHook(request, reply) {
  const authStart = Date.now()
  const path = request.url.split('?')[0]
  if (path === '/health' || path === '/auth/login' || path === '/metrics') return

  const authHeader = request.headers['authorization']
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.code(401).send({
      error:   'unauthorized',
      message: 'Missing or invalid Authorization header.',
    })
  }

  const rawToken = authHeader.slice(7).trim()

  try {
    let ctx

    if (rawToken.startsWith('aig_agt_')) {
      // ── Agent API key ────────────────────────────────────────────────────
      ctx = await resolveAgent(this.db, rawToken)
    } else if (rawToken.includes('.')) {
      // ── JWT session (from /auth/login) ───────────────────────────────────
      ctx = await resolveUserByJWT(this.db, rawToken)
    } else {
      // ── Developer API key ────────────────────────────────────────────────
      ctx = await resolveUserByKey(this.db, rawToken)
    }

    if (!ctx) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Invalid token' })
    }
    if (ctx.inactive) {
      return reply.code(403).send({ error: 'forbidden', message: 'Account is inactive' })
    }

    request.ctx = { ...ctx, authMs: Date.now() - authStart, requestStart: authStart }

  } catch (err) {
    request.log.error({ err }, 'Auth error')
    if (err.code === 'ERR_JWT_EXPIRED') {
      return reply.code(401).send({ error: 'token_expired', message: 'Session expired. Please log in again.' })
    }
    return reply.code(500).send({ error: 'internal', message: 'Authentication error' })
  }
}

// ─── Resolvers ────────────────────────────────────────────────────────────────

async function resolveUserByKey(db, rawKey) {
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex')
  const { rows } = await db.query(
    `SELECT id, org_id, team_id, email, name, role, is_active
     FROM users WHERE api_key_hash = $1`,
    [hash]
  )
  const u = rows[0]
  if (!u) return null
  if (!u.is_active) return { inactive: true }
  const { team, policy } = await loadTeamAndPolicy(db, u.team_id)
  return { user: u, agent: null, team, policy }
}

async function resolveUserByJWT(db, token) {
  const { payload } = await jwtVerify(token, JWT_SECRET)
  const { rows } = await db.query(
    `SELECT id, org_id, team_id, email, name, role, is_active
     FROM users WHERE id = $1`,
    [payload.userId]
  )
  const u = rows[0]
  if (!u) return null
  if (!u.is_active) return { inactive: true }
  const { team, policy } = await loadTeamAndPolicy(db, u.team_id)
  return { user: u, agent: null, team, policy }
}

async function resolveAgent(db, rawKey) {
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex')
  const { rows } = await db.query(
    `SELECT id, org_id, team_id, name, is_active, default_model, default_provider
     FROM agents WHERE api_key_hash = $1`,
    [hash]
  )
  const a = rows[0]
  if (!a) return null
  if (!a.is_active) return { inactive: true }
  const { team, policy } = await loadTeamAndPolicy(db, a.team_id)
  // Represent agent as a pseudo-user so the rest of the pipeline stays identical
  return {
    user:  { id: a.org_id, org_id: a.org_id, team_id: a.team_id, name: a.name, role: 'agent' },
    agent: {
      id:               a.id,
      name:             a.name,
      team_id:          a.team_id,
      default_model:    a.default_model,
      default_provider: a.default_provider,
    },
    team,
    policy,
  }
}

// ─── Shared helper ────────────────────────────────────────────────────────────

async function loadTeamAndPolicy(db, teamId) {
  if (!teamId) return { team: null, policy: null }
  const { rows } = await db.query(
    `SELECT
       t.id, t.name, t.org_id, t.monthly_budget_usd,
       p.id AS policy_id, p.name AS policy_name,
       p.allowed_models, p.max_tokens_per_request,
       p.monthly_token_quota, p.monthly_budget_usd AS policy_budget
     FROM teams t
     LEFT JOIN policies p ON p.id = t.policy_id
     WHERE t.id = $1`,
    [teamId]
  )
  if (!rows[0]) return { team: null, policy: null }
  const r = rows[0]
  return {
    team: {
      id: r.id, name: r.name, org_id: r.org_id,
      monthly_budget_usd: r.monthly_budget_usd,
    },
    policy: {
      id: r.policy_id, name: r.policy_name,
      allowed_models:         r.allowed_models ?? [],
      max_tokens_per_request: r.max_tokens_per_request,
      monthly_token_quota:    r.monthly_token_quota,
      monthly_budget_usd:     r.policy_budget,
    },
  }
}
