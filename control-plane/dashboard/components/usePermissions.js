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
 */
export function usePermissions() {
  const [perms, setPerms] = useState(null)
  useEffect(() => {
    let live = true
    fetch('/api/session')
      .then(r => (r.ok ? r.json() : null))
      .then(me => { if (live) setPerms(me?.permissions ?? {}) })
      .catch(() => { if (live) setPerms({}) })
    return () => { live = false }
  }, [])
  return {
    ready: perms !== null,
    can: permission => Boolean(perms?.[permission]),
    scope: permission => perms?.[permission] ?? null,
  }
}
