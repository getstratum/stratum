export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { jwtVerify }   from 'jose'
import { getSessionSecret } from '@/lib/secret'

function getSecret() {
  return getSessionSecret()
}

// GET /api/playground-token
// If the user has a valid dashboard session cookie, return the embedded proxy JWT.
// The Playground calls this on mount to avoid asking Engineering users to log in twice.
export async function GET(req) {
  const cookie = req.cookies.get('stratum_session')?.value
  if (!cookie) {
    return NextResponse.json({ token: null }, { status: 200 })
  }

  try {
    const { payload } = await jwtVerify(cookie, getSecret())
    return NextResponse.json({
      token:    payload.token    ?? null,
      email:    payload.email    ?? null,
      name:     payload.name     ?? null,
      teamName: payload.teamName ?? null,
    })
  } catch {
    // Expired or invalid session
    return NextResponse.json({ token: null }, { status: 200 })
  }
}
