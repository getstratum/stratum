/**
 * lib/login.js — throttling shared by both steps of the console sign-in:
 * the password (POST /api/session) and the second factor
 * (POST /api/session/mfa). Every try of either counts, and so does every
 * check of the password or a code from inside a session (setting up or
 * turning off the second factor, new recovery codes): a stolen session
 * must not be a way to guess them without limit.
 */

// After this many failed attempts in a row the account is locked for
// LOCK_MINUTES. The counter resets on a successful sign-in.
export const MAX_FAILED = 10
export const LOCK_MINUTES = 15

export const INVALID = 'Email o contraseña incorrectos, o la cuenta está bloqueada por unos minutos.'

/**
 * Reserves an attempt before checking anything, atomically: at most
 * MAX_FAILED attempts can be in flight or counted until a success resets
 * the counter, however many requests arrive at once. null: locked.
 */
export async function reserveAttempt(db, userId) {
  const r = await db.query(
    `UPDATE users SET failed_logins = failed_logins + 1
      WHERE id = $1 AND (locked_until IS NULL OR locked_until <= now()) AND failed_logins < $2
      RETURNING failed_logins`,
    [userId, MAX_FAILED])
  const reserved = r.rows[0] ?? null
  if (!reserved) {
    // A counter left at the limit without a lock (a request that died
    // after reserving) becomes a lock that expires, never a permanent one.
    await db.query(
      `UPDATE users SET failed_logins = 0, locked_until = now() + make_interval(mins => $3)
        WHERE id = $1 AND (locked_until IS NULL OR locked_until <= now()) AND failed_logins >= $2`,
      [userId, MAX_FAILED, LOCK_MINUTES])
  }
  return reserved
}

/** A reserved attempt failed: lock when it was the last one allowed. */
export async function recordFailure(db, userId, reserved) {
  if (reserved && reserved.failed_logins >= MAX_FAILED) {
    await db.query(
      `UPDATE users SET failed_logins = 0, locked_until = now() + make_interval(mins => $2) WHERE id = $1`,
      [userId, LOCK_MINUTES])
  }
}

/**
 * The sign-in succeeded: reset the counter. False if a concurrent failure
 * locked the account meanwhile (then the sign-in is refused).
 */
export async function recordSuccess(db, userId, newPasswordHash = null) {
  const done = await db.query(
    `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now(),
                      password_hash = COALESCE($2, password_hash)
      WHERE id = $1 AND (locked_until IS NULL OR locked_until <= now())
      RETURNING id`,
    [userId, newPasswordHash])
  return !!done.rows[0]
}

/**
 * Runs a check of a password or code typed inside a session, counted like
 * a sign-in attempt. Returns true when it passed, false when it did not,
 * and 'locked' when the account is locked (then nothing was checked).
 */
export async function guardedCheck(db, userId, check) {
  const reserved = await reserveAttempt(db, userId)
  if (!reserved) return 'locked'
  if (!(await check())) {
    await recordFailure(db, userId, reserved)
    return false
  }
  await db.query(
    `UPDATE users SET failed_logins = 0 WHERE id = $1 AND (locked_until IS NULL OR locked_until <= now())`,
    [userId])
  return true
}

export const LOCKED_IN_SESSION = 'Demasiados intentos fallidos: la cuenta queda bloqueada unos minutos.'
