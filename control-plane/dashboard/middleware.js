import { NextResponse } from 'next/server'
import { jwtVerify } from 'jose'
import { getSessionSecret } from './lib/secret.js'

// Paths that never require dashboard auth
const PUBLIC_PATHS = [
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

export async function middleware(request) {
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

    // Inject user info into headers for server components
    const headers = new Headers(request.headers)
    headers.set('x-session-email',    payload.email    ?? '')
    headers.set('x-session-team',     payload.teamName ?? '')
    headers.set('x-session-token',    payload.token    ?? '')

    return NextResponse.next({ request: { headers } })

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
