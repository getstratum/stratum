/**
 * lib/totp.js — time-based one-time passwords (RFC 6238, the format every
 * authenticator app uses: HMAC-SHA1, 6 digits, 30-second steps) and the
 * recovery codes that replace a lost authenticator.
 */

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

const STEP_SECONDS = 30
const DIGITS = 6
// Codes from one step before and after the current one are accepted, for
// clocks that drift and people who type slowly.
const WINDOW = 1

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf) {
  let bits = 0, value = 0, out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0, value = 0
  const out = []
  for (const ch of clean) {
    const i = B32.indexOf(ch)
    if (i < 0) throw new Error('invalid base32')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A new secret: 20 random bytes (160 bits, as RFC 4226 recommends), base32. */
export const newSecret = () => base32Encode(randomBytes(20))

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS)

/** The code for a step. */
export function codeAt(secret, step, digits = DIGITS) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return String(n).padStart(digits, '0')
}

/**
 * The step a code belongs to, within the window around `ms`, or null. A
 * caller must refuse a step at or below the last one it accepted, so the
 * same code cannot be used twice.
 */
export function matchStep(secret, code, ms = Date.now()) {
  const typed = String(code ?? '').replace(/\s/g, '')
  if (!/^\d{6}$/.test(typed)) return null
  const now = stepAt(ms)
  let found = null
  for (let s = now - WINDOW; s <= now + WINDOW; s++) {
    // Compare every candidate in constant time, and check all of them.
    if (timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(typed)) && found === null) found = s
  }
  return found
}

/** otpauth:// URI for authenticator apps (and the QR code that carries it). */
export function otpauthUri({ secret, account, issuer = 'Stratum' }) {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) })
  return `otpauth://totp/${label}?${q}`
}

// Recovery codes: 10 of them, each 10 characters of base32 shown as
// xxxxx-xxxxx (50 bits), one use each.
export const RECOVERY_CODES = 10

export function newRecoveryCodes(n = RECOVERY_CODES) {
  const codes = []
  for (let i = 0; i < n; i++) {
    let c = ''
    for (let j = 0; j < 10; j++) c += B32[randomInt(32)]
    codes.push(`${c.slice(0, 5)}-${c.slice(5)}`.toLowerCase())
  }
  return codes
}

/** Normal form of a typed recovery code: lower case, no spaces or dashes. */
export const normalizeRecoveryCode = (code) => String(code ?? '').toLowerCase().replace(/[\s-]/g, '')

export const looksLikeRecoveryCode = (code) => /^[a-z2-7]{10}$/.test(normalizeRecoveryCode(code))
