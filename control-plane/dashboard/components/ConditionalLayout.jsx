'use client'

import { usePathname } from 'next/navigation'
import Sidebar from './Sidebar'

const NO_SIDEBAR_PATHS = ['/login', '/oidc']

// Any console API answer of 401 means the session is gone (expired, revoked,
// signed out elsewhere, or a database that was recreated): send the browser
// to the sign-in page. A 403 that asks for the second factor first sends it
// to the account page.
//
// Installed when this module loads, not in an effect: React runs the page's
// effects before its layout's, so a page's first requests would otherwise
// go out unwatched, and it would render the 401 as if it were data.
function watchSession() {
  if (typeof window === 'undefined' || window.__stratumFetchWrapped) return
  const original = window.fetch
  window.__stratumFetchWrapped = true
  window.fetch = async (...args) => {
    const res = await original(...args)
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? ''
    const path = window.location.pathname
    if (!url.startsWith('/api/') || NO_SIDEBAR_PATHS.some(p => path === p || path.startsWith(p + '/'))) return res
    if (res.status === 401 && !url.startsWith('/api/session')) {
      window.location.replace('/login?reason=session_expired')
    } else if (res.status === 403 && path !== '/account') {
      const body = await res.clone().json().catch(() => null)
      if (body?.error === 'mfa_enrollment_required') window.location.replace('/account?mfa=required')
    }
    return res
  }
}
watchSession()

export default function ConditionalLayout({ children }) {
  const path = usePathname()
  const noSidebar = NO_SIDEBAR_PATHS.some(p => path === p || path.startsWith(p + '/'))

  if (noSidebar) {
    return (
      <div className="h-screen bg-app text-default flex flex-col">
        {children}
      </div>
    )
  }

  return (
    <div className="flex flex-col md:flex-row h-screen overflow-hidden bg-app text-default">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-y-auto">
        {children}
      </main>
    </div>
  )
}
