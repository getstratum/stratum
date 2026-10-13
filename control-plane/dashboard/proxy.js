/**
 * proxy.js — dashboard authentication (Next.js 16 "proxy", formerly middleware).
 *
 * Runs before every route. Pages and API routes outside PUBLIC_PATHS require a
 * valid stratum_session cookie signed with SESSION_SECRET.
 */
import { NextResponse } from 'next/server'
import { jwtVerify } from 'jose'
import { getSessionSecret } from './lib/secret.js'

// Paths that never require dashboard auth
const PUBLIC_PATHS = [
  '/api/healthz',            // container health check
  '/login',
  '/prompt',
  '/api/session',
  '/api/auth',
  '/api/playground-token',   // accessible to any authenticated user (validated inside the route)
  '/api/internal',           // sync token auth handled by each route — bypass dashboard JWT
]

// Teams allowed to access the dashboard
const DASHBOARD_TEAMS = ['Engineering']

function getSecret() {
  return getSessionSecret()
}

export async function proxy(request) {
  const { pathname } = request.nextUrl

  // Always allow public paths
  if (PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next()
  }

  // Allow Next.js internals
  if (pathname.startsWith('/_next') || pathname === '/favicon.ico') {
    return NextResponse.next()
  }

  const sessionCookie = request.cookies.get('stratum_session')?.value

  if (!sessionCookie) {
    // API clients get a proper 401 instead of an HTML redirect
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'unauthorized', message: 'Sign in to the dashboard first' }, { status: 401 })
    }
    // No session → send everyone to Playground first
    // Admins can reach the dashboard via the Admin button in the Playground
    if (pathname.startsWith('/login')) return NextResponse.next()
    return NextResponse.redirect(new URL('/prompt', request.url))
  }

  try {
    const { payload } = await jwtVerify(sessionCookie, getSecret())

    // Check team access
    if (!DASHBOARD_TEAMS.includes(payload.teamName)) {
      // API routes → return JSON error instead of redirect
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'forbidden', message: 'Dashboard access requires Engineering team membership' }, { status: 403 })
      }
      // UI routes → send to Playground
      return NextResponse.redirect(new URL('/prompt', request.url))
    }

    return NextResponse.next()

  } catch {
    // Invalid or expired session → back to login
    const response = NextResponse.redirect(new URL('/login', request.url))
    response.cookies.delete('stratum_session')
    return response
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
