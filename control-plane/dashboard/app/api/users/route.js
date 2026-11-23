export const dynamic = 'force-dynamic'
import { route, readJson, json, badRequest, forbidden, conflict, assertTeamInScope } from '../../../lib/route.js'
import { assignableRoles } from '../../../lib/authz.js'
import { hashPassword, passwordProblem } from '../../../lib/password.js'
import { USER_COLUMNS, newApiKey, validEmail } from '../../../lib/users.js'
import { audit } from '../../../lib/audit.js'
import { withRoom } from '../../../lib/org-limits.js'

export const GET = route('users.read', async (req, { session, db }) => {
  const team = session.scope === 'team'
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS}
       FROM users u
       LEFT JOIN teams t ON t.id = u.team_id
      WHERE u.org_id = $1 ${team ? 'AND u.team_id = $2' : ''}
      ORDER BY u.created_at DESC`,
    team ? [session.orgId, session.teamId] : [session.orgId])
  return json(rows)
})

export const POST = route('users.manage', async (req, { session, db }) => {
  const body = await readJson(req)
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const role = body.role ?? 'member'
  const teamId = body.teamId || (session.scope === 'team' ? session.teamId : null)

  if (!validEmail(email)) throw badRequest('Email inválido.')
  if (!assignableRoles(session.role).includes(role)) throw forbidden('Tu rol no puede asignar ese rol.')
  await assertTeamInScope(db, session, teamId)
  if (role === 'team_manager' && !teamId) throw badRequest('Un gestor de equipo necesita un equipo.')
  if (body.password != null && session.role === 'team_manager') {
    throw forbidden('Tu rol no puede definir contraseñas.')
  }
  // A service token provisions people who sign in with the organization's
  // identity provider (SSO): it sets no passwords, and they need none.
  if (session.role === 'service' && body.password != null) throw forbidden('Un token de servicio no define contraseñas.')
  if (session.role === 'service' && body.giveApiKey) throw forbidden('Un token de servicio no genera keys de personas.')
  if (body.password != null) {
    const problem = passwordProblem(body.password)
    if (problem) throw badRequest(problem)
  }
  if (body.password == null && !body.giveApiKey && session.role !== 'service') {
    throw badRequest('La persona necesita contraseña o API key (o ambas).')
  }

  const key = body.giveApiKey ? newApiKey('aig_sk_') : null
  const passwordHash = body.password != null ? await hashPassword(body.password) : null
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 255) : email.split('@')[0]

  // The plan may cap the organization's active people (ADR-0020).
  const created = await withRoom(db, session.orgId, 'people', async (tx) => {
    let row
    try {
      const { rows } = await tx.query(
        `INSERT INTO users (org_id, team_id, email, name, role, api_key_hash, api_key_prefix, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [session.orgId, teamId, email, name, role, key?.hash ?? null, key?.prefix ?? null, passwordHash])
      row = rows[0]
    } catch (err) {
      if (err.code === '23505') throw conflict('Ya existe una cuenta con ese email.')
      throw err
    }
    return row
  })
  // After the transaction: audit() swallows its own errors, and one inside
  // it would turn the COMMIT into a silent rollback.
  await audit(db, {
    req, session, action: 'user.create', targetType: 'user', targetId: created.id,
    details: { email, role, teamId, password: passwordHash != null, apiKey: key != null },
  })
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS} FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = $1`,
    [created.id])
  return json({ user: rows[0], apiKey: key?.raw ?? null }, 201)
})
