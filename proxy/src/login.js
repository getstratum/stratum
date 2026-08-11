import crypto   from 'crypto'
import { SignJWT } from 'jose'

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'change-me-in-production-min-32-chars'
)

// ─── Password verification ────────────────────────────────────────────────────

async function verifyPassword(candidate, stored) {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false

  const derived = await new Promise((res, rej) =>
    crypto.scrypt(candidate, salt, 64, (err, key) =>
      err ? rej(err) : res(key.toString('hex'))
    )
  )

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hash,    'hex'),
      Buffer.from(derived, 'hex')
    )
  } catch {
    return false
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function loginRoute(request, reply) {
  request.log.info({ url: request.url }, 'login attempt')

  const { email, password } = request.body ?? {}

  if (!email || !password) {
    return reply.code(400).send({ error: 'Email y contraseña requeridos' })
  }

  try {
  // Find user
  const { rows } = await this.db.query(
    `SELECT id, org_id, team_id, email, name, role, is_active, password_hash
     FROM users
     WHERE email = $1 AND is_active = true`,
    [email.trim().toLowerCase()]
  )
  const user = rows[0]

  // Always run verifyPassword to avoid timing oracle even if user not found
  const hashedPlaceholder = 'deadbeef:deadbeef'
  const storedHash = user?.password_hash ?? hashedPlaceholder

  const valid = await verifyPassword(password, storedHash)

  if (!user || !user.password_hash || !valid) {
    return reply.code(401).send({ error: 'Email o contraseña incorrectos' })
  }

  // Load team + policy + allowed models
  const teamPolicy = await loadTeamPolicy(this.db, user.team_id)

  // Sign session JWT (24h)
  const token = await new SignJWT({
    userId: user.id,
    email:  user.email,
    orgId:  user.org_id,
    teamId: user.team_id,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(JWT_SECRET)

  return reply.send({
    token,
    user: {
      id:    user.id,
      email: user.email,
      name:  user.name,
      role:  user.role,
    },
    team:   teamPolicy.team,
    policy: teamPolicy.policy,
    models: teamPolicy.models,
  })
  } catch (err) {
    request.log.error({ err }, 'Login error')
    return reply.code(500).send({ error: 'Error interno al autenticar' })
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loadTeamPolicy(db, teamId) {
  if (!teamId) return { team: null, policy: null, models: [] }

  const { rows } = await db.query(
    `SELECT t.id AS team_id, t.name AS team_name, t.org_id,
            p.id AS policy_id, p.name AS policy_name,
            p.allowed_models, p.max_tokens_per_request,
            p.monthly_token_quota, p.monthly_budget_usd
     FROM teams t
     LEFT JOIN policies p ON p.id = t.policy_id
     WHERE t.id = $1`,
    [teamId]
  )

  const r = rows[0]
  if (!r) return { team: null, policy: null, models: [] }

  let models = []
  if (r.allowed_models?.length) {
    const { rows: modelRows } = await db.query(
      `SELECT provider, model_id, display_name,
              cost_per_1k_input_tokens, cost_per_1k_output_tokens
       FROM ai_models WHERE model_id = ANY($1) AND is_active = true
       ORDER BY provider, display_name`,
      [r.allowed_models]
    )
    models = modelRows
  }

  return {
    team: {
      id:   r.team_id,
      name: r.team_name,
    },
    policy: {
      id:             r.policy_id,
      name:           r.policy_name,
      allowed_models: r.allowed_models ?? [],
    },
    models,
  }
}

// ─── Export secret for use in auth.js ────────────────────────────────────────
export { JWT_SECRET }
