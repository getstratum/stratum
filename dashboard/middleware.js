import { NextResponse } from 'next/server'
import { jwtVerify } from 'jose'

// Paths that never require dashboard auth
const PUBLIC_PATHS = [
  '/login',
  '/prompt',
  '/api/session',
  '/api/auth',
]

// Teams allowed to access the dashboard
const DASHBOARD_TEAMS = ['Engineering']

function getSecret() {
  return new TextEncoder().encode(
    process.env.SESSION_SECRET ?? 'stratum-dashboard-secret-change-in-prod'
  )
}

export async function middleware(request) {
  const { pathname } = request.nextUrl

  // Always allow public paths
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // Allow Next.js internals
  if (pathname.startsWith('/_next') || pathname === '/favicon.ico') {
    return NextResponse.next()
  }

  const sessionCookie = request.cookies.get('stratum_session')?.value

  if (!sessionCookie) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  try {
    const { payload } = await jwtVerify(sessionCookie, getSecret())

    // Check team access
    if (!DASHBOARD_TEAMS.includes(payload.teamName)) {
      // Valid session but wrong team → send to Playground
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
