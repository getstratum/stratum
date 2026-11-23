'use client'

import { useEffect, useState } from 'react'

/**
 * What the signed-in person may do, from /api/session. Pages use it only to
 * hide controls that would be refused: the server checks every permission
 * again (lib/route.js).
 *
 *   const { can } = usePermissions()
 *   can('users.manage')    // false until the session has loaded
 *   scope('keys.manage')   // 'org' | 'team' | 'self' | null
 *   fixed('people')        // "Fijado por tu plan (Empresa): 25 personas activas.", or null
 *
 * fixed(kind) says the organization reached its plan's limit for people,
 * agents, teams or gateways (ADR-0020): the page disables what would add
 * one more and says why, instead of failing on save.
 */
export function usePermissions() {
  const [perms, setPerms] = useState(null)
  const [reached, setReached] = useState({})
  useEffect(() => {
    let live = true
    fetch('/api/session')
      .then(r => (r.ok ? r.json() : null))
      .then(me => { if (live) { setPerms(me?.permissions ?? {}); setReached(me?.org?.reached ?? {}) } })
      .catch(() => { if (live) setPerms({}) })
    return () => { live = false }
  }, [])
  return {
    ready: perms !== null,
    can: permission => Boolean(perms?.[permission]),
    scope: permission => perms?.[permission] ?? null,
    fixed: kind => reached[kind] ?? null,
  }
}
