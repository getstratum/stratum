/**
 * lib/secrets.js — provider credentials at rest: AES-256-GCM with
 * STRATUM_ENCRYPTION_KEY (64 hex characters).
 *
 * Stored as "<iv hex>:<ciphertext + 16-byte tag, base64>".
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

function key() {
  const hex = process.env.STRATUM_ENCRYPTION_KEY
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('STRATUM_ENCRYPTION_KEY not configured')
  return Buffer.from(hex, 'hex')
}

export function encryptSecret(plaintext) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const out = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return `${iv.toString('hex')}:${out.toString('base64')}`
}

export function decryptSecret(stored) {
  const [ivHex, b64] = String(stored).split(':')
  if (!ivHex || b64 === undefined) throw new Error('Invalid encrypted format')
  const data = Buffer.from(b64, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(data.subarray(-16))
  return decipher.update(data.subarray(0, -16), undefined, 'utf8') + decipher.final('utf8')
}

/**
 * What the console may show of a credential: its last four characters, or
 * only that there is one when it is too short to show any. Null: no
 * credential.
 */
export function secretHint(plaintext) {
  if (!plaintext) return null
  return plaintext.length >= 12 ? `…${plaintext.slice(-4)}` : '••••'
}
