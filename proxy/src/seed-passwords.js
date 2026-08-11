/**
 * Sets real scrypt-hashed passwords for seed users.
 * Run once after first docker-compose up:
 *
 *   docker exec -it $(docker compose ps -q proxy) node /app/src/seed-passwords.js
 */

import crypto from 'crypto'
import pg from 'pg'

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL })

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = await new Promise((res, rej) =>
    crypto.scrypt(password, salt, 64, (err, key) =>
      err ? rej(err) : res(key.toString('hex'))
    )
  )
  return `${salt}:${hash}`
}

const seeds = [
  { email: 'dev@acme.com',        password: 'dev123' },
  { email: 'marketing@acme.com',  password: 'mkt123' },
]

for (const { email, password } of seeds) {
  const hash = await hashPassword(password)
  await db.query('UPDATE users SET password_hash = $1 WHERE email = $2', [hash, email])
  console.log(`✓ Password set for ${email}`)
}

await db.end()
console.log('\nDone. Test credentials:')
console.log('  dev@acme.com        / dev123')
console.log('  marketing@acme.com  / mkt123')
