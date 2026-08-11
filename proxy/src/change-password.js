import crypto from 'crypto'

async function verifyPassword(candidate, stored) {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const derived = await new Promise((res, rej) =>
    crypto.scrypt(candidate, salt, 64, (err, key) =>
      err ? rej(err) : res(key.toString('hex'))
    )
  )
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'))
  } catch { return false }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = await new Promise((res, rej) =>
    crypto.scrypt(password, salt, 64, (err, key) =>
      err ? rej(err) : res(key.toString('hex'))
    )
  )
  return `${salt}:${hash}`
}

export async function changePasswordRoute(request, reply) {
  const { currentPassword, newPassword } = request.body ?? {}

  if (!currentPassword || !newPassword) {
    return reply.code(400).send({ error: 'currentPassword and newPassword are required' })
  }
  if (newPassword.length < 6) {
    return reply.code(400).send({ error: 'New password must be at least 6 characters' })
  }

  const { user } = request.ctx

  // Load current password hash
  const { rows } = await this.db.query(
    'SELECT password_hash FROM users WHERE id = $1',
    [user.id]
  )
  const storedHash = rows[0]?.password_hash

  if (!storedHash) {
    return reply.code(400).send({
      error: 'This account uses API key authentication and has no password. Set one from the admin dashboard.'
    })
  }

  const valid = await verifyPassword(currentPassword, storedHash)
  if (!valid) {
    return reply.code(401).send({ error: 'Current password is incorrect' })
  }

  const newHash = await hashPassword(newPassword)
  await this.db.query(
    'UPDATE users SET password_hash = $1 WHERE id = $2',
    [newHash, user.id]
  )

  return reply.send({ ok: true, message: 'Password updated successfully' })
}
