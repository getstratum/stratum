/**
 * lib/password.js — console passwords, hashed with scrypt.
 *
 * Stored as  scrypt$<N>$<r>$<p>$<salt hex>$<hash hex>.  The older
 * <salt hex>:<hash hex> form (Node's default parameters, used by the
 * dashboard before migration 016) is still verified, and needsRehash()
 * tells the caller to store it again in the current form.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'

const N = 2 ** 15
const R = 8
const P = 1
const KEYLEN = 64
const MAXMEM = 128 * N * R * 2

export const MIN_LENGTH = 12
export const MAX_LENGTH = 256

function scrypt(password, salt, n, r, p) {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key)))
}

/** Why `password` is not acceptable, or null. */
export function passwordProblem(password) {
  if (typeof password !== 'string') return 'La contraseña es obligatoria.'
  if (password.length < MIN_LENGTH) return `La contraseña necesita al menos ${MIN_LENGTH} caracteres.`
  if (password.length > MAX_LENGTH) return `La contraseña admite hasta ${MAX_LENGTH} caracteres.`
  return null
}

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, N, R, P)
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${key.toString('hex')}`
}

function parse(stored) {
  if (typeof stored !== 'string') return null
  if (stored.startsWith('scrypt$')) {
    const [, n, r, p, salt, hash] = stored.split('$')
    if (!salt || !hash) return null
    return { n: Number(n), r: Number(r), p: Number(p), salt: Buffer.from(salt, 'hex'), hash: Buffer.from(hash, 'hex') }
  }
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return null
  // Legacy: the salt was used as a string, with Node's defaults.
  return { n: 16384, r: 8, p: 1, salt, hash: Buffer.from(hash, 'hex') }
}

// Compared against when the account does not exist or has no password, so
// the response time does not reveal which emails have accounts.
const DUMMY = { n: N, r: R, p: P, salt: Buffer.alloc(16), hash: Buffer.alloc(KEYLEN) }

export async function verifyPassword(password, stored) {
  const parsed = parse(stored)
  const target = parsed && parsed.hash.length === KEYLEN && parsed.n <= N ? parsed : DUMMY
  if (typeof password !== 'string' || password.length > MAX_LENGTH) password = ''
  const key = await scrypt(password, target.salt, target.n, target.r, target.p)
  return target !== DUMMY && timingSafeEqual(key, target.hash)
}

export function needsRehash(stored) {
  return typeof stored === 'string' && !stored.startsWith(`scrypt$${N}$${R}$${P}$`)
}
