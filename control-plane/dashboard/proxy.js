/**
 * proxy.js — page routing for the console (Next.js 16 "proxy", formerly middleware).
 *
 * Pages hold no data: everything they show comes from /api routes, and each
 * of those checks the session and the role itself (lib/route.js). So this
 * only sends a browser without a session cookie to /login; it does not
 * decide access.
 */
import { NextResponse } from 'next/server'
import { COOKIE } from './lib/session-cookie.js'

export function proxy(request) {
  const { pathname } = request.nextUrl
  if (pathname === '/login' || pathname.startsWith('/api/')) return NextResponse.next()
  if (!request.cookies.get(COOKIE)?.value) {
    return NextResponse.redirect(new URL('/login', request.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
