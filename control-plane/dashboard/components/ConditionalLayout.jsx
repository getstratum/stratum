'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import Sidebar from './Sidebar'

const NO_SIDEBAR_PATHS = ['/login']

// Any console API answer of 401 means the session is gone (expired, revoked,
// signed out elsewhere): send the browser to the sign-in page. A 403 that
// asks for the second factor first sends it to the account page.
function useSessionWatch(enabled) {
  useEffect(() => {
    if (!enabled || window.__stratumFetchWrapped) return
    const original = window.fetch
    window.__stratumFetchWrapped = true
    window.fetch = async (...args) => {
      const res = await original(...args)
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? ''
      if (res.status === 401 && url.startsWith('/api/') && !url.startsWith('/api/session')) {
        window.location.replace('/login?reason=session_expired')
      } else if (res.status === 403 && url.startsWith('/api/') && window.location.pathname !== '/account') {
        const body = await res.clone().json().catch(() => null)
        if (body?.error === 'mfa_enrollment_required') window.location.replace('/account?mfa=required')
      }
      return res
    }
  }, [enabled])
}

export default function ConditionalLayout({ children }) {
  const path = usePathname()
  const noSidebar = NO_SIDEBAR_PATHS.some(p => path === p || path.startsWith(p + '/'))
  useSessionWatch(!noSidebar)

  if (noSidebar) {
    return (
      <div className="h-screen bg-app text-default flex flex-col">
        {children}
      </div>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden bg-app text-default">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  )
}
