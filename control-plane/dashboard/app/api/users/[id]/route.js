export const dynamic = 'force-dynamic'
import { route, readJson, json, badRequest, forbidden, assertTeamInScope, withTransaction } from '../../../../lib/route.js'
import { assignableRoles, ROLES } from '../../../../lib/authz.js'
import { hashPassword, passwordProblem } from '../../../../lib/password.js'
import { USER_COLUMNS, newApiKey, loadManagedUser, assertAnotherOwner } from '../../../../lib/users.js'
import { revokeUserSessions } from '../../../../lib/session.js'
import { audit } from '../../../../lib/audit.js'

async function reload(db, id) {
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS} FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = $1`, [id])
  return rows[0]
}

export const PATCH = route('users.manage', async (req, { session, db: pool, params }) => {
  const body = await readJson(req)
  // One transaction, serialized per organization: two owners demoting each
  // other at the same time must not leave the organization without one.
  const id = await withTransaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`org-users:${session.orgId}`])
    const target = await loadManagedUser(db, session, params.id)
    const self = target.id === session.userId

    const fields = []
    const values = []
    const changed = {}
    const set = (col, val, label) => { values.push(val); fields.push(`${col} = $${values.length}`); changed[label] = true }

    if (body.teamId !== undefined) {
      const teamId = body.teamId || null
      await assertTeamInScope(db, session, teamId)
      set('team_id', teamId, 'teamId')
    }
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) throw badRequest('Rol inválido.')
      if (self) throw forbidden('No podés cambiar tu propio rol.')
      if (!assignableRoles(session.role).includes(body.role)) throw forbidden('Tu rol no puede asignar ese rol.')
      if (target.role === 'owner' && body.role !== 'owner') await assertAnotherOwner(db, session.orgId, target.id)
      set('role', body.role, 'role')
    }
    const finalRole = body.role ?? target.role
    const finalTeam = body.teamId !== undefined ? (body.teamId || null) : target.team_id
    if (finalRole === 'team_manager' && !finalTeam) throw badRequest('Un gestor de equipo necesita un equipo.')

    if (body.isActive !== undefined) {
      if (typeof body.isActive !== 'boolean') throw badRequest('isActive tiene que ser true o false.')
      if (self && !body.isActive) throw forbidden('No podés desactivarte a vos mismo.')
      if (target.role === 'owner' && !body.isActive) await assertAnotherOwner(db, session.orgId, target.id)
      set('is_active', body.isActive, 'isActive')
    }
    if (body.appAccess !== undefined) {
      // Applications built on the gateway (migration 028): taking access
      // away reaches gateways in the next sync.
      if (typeof body.appAccess !== 'boolean') throw badRequest('appAccess tiene que ser true o false.')
      set('app_access', body.appAccess, 'appAccess')
    }
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) throw badRequest('Nombre inválido.')
      set('name', body.name.trim().slice(0, 255), 'name')
    }
    if (body.newPassword != null || body.removePassword) {
      // Your own password changes in "Mi cuenta" (POST /api/session/password),
      // which asks for the current one. Team managers do not set passwords:
      // their members have no console access, and a password they knew
      // would still work if the member were promoted later.
      if (self) throw forbidden('Tu contraseña se cambia desde Mi cuenta.')
      if (session.role === 'team_manager') throw forbidden('Tu rol no puede definir contraseñas.')
      if (body.newPassword != null) {
        const problem = passwordProblem(body.newPassword)
        if (problem) throw badRequest(problem)
        set('password_hash', await hashPassword(body.newPassword), 'password')
      } else {
        set('password_hash', null, 'removePassword')
      }
    }

    if (!fields.length) throw badRequest('Nada para actualizar.')

    values.push(target.id, session.orgId)
    await db.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${values.length - 1} AND org_id = $${values.length}`,
      values)

    // Access changed: end the person's console sessions.
    if (changed.role || changed.isActive || changed.password || changed.removePassword || changed.teamId) {
      await revokeUserSessions(db, target.id)
    }

    await audit(db, {
      req, session, action: 'user.update', targetType: 'user', targetId: target.id,
      details: {
        email: target.email,
        changed: Object.keys(changed),
        ...(changed.role ? { role: { from: target.role, to: body.role } } : {}),
        ...(changed.isActive ? { isActive: body.isActive } : {}),
        ...(changed.teamId ? { teamId: body.teamId || null } : {}),
        ...(changed.appAccess ? { appAccess: body.appAccess } : {}),
      },
    })
    return target.id
  })
  return json(await reload(pool, id))
})

// POST /api/users/:id  { action: 'rotate-key' | 'remove-key' }
export const POST = route('keys.manage', async (req, { session, db, params }) => {
  const target = await loadManagedUser(db, session, params.id)
  const { action } = await readJson(req)

  if (action === 'rotate-key') {
    const key = newApiKey('aig_sk_')
    await db.query(
      'UPDATE users SET api_key_hash = $1, api_key_prefix = $2 WHERE id = $3 AND org_id = $4',
      [key.hash, key.prefix, target.id, session.orgId])
    await audit(db, { req, session, action: 'user.key.rotate', targetType: 'user', targetId: target.id, details: { email: target.email } })
    return json({ apiKey: key.raw })
  }

  if (action === 'remove-key') {
    await db.query(
      'UPDATE users SET api_key_hash = NULL, api_key_prefix = NULL WHERE id = $1 AND org_id = $2',
      [target.id, session.orgId])
    await audit(db, { req, session, action: 'user.key.revoke', targetType: 'user', targetId: target.id, details: { email: target.email } })
    return json({ ok: true })
  }

  throw badRequest('Acción desconocida.')
})
