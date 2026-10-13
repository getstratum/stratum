/**
 * lib/secret.js — the one place the session signing secret is read.
 *
 * There is deliberately no fallback value: a dashboard started without
 * SESSION_SECRET would sign sessions with a string published in this
 * repository, which lets anyone forge an admin session.
 */
export function getSessionSecret() {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters (openssl rand -hex 32)')
  }
  return new TextEncoder().encode(secret)
}
