import { NextResponse } from 'next/server'
import { SignJWT }       from 'jose'

// Server-side calls use internal Docker network URL
// GATEWAY_INTERNAL_URL = http://proxy:8080 (docker service name)
// Falls back to NEXT_PUBLIC_GATEWAY_URL for local dev
const GATEWAY = process.env.GATEWAY_INTERNAL_URL
             ?? process.env.NEXT_PUBLIC_GATEWAY_URL
             ?? 'http://localhost:8080'

function getSecret() {
  return new TextEncoder().encode(
    process.env.SESSION_SECRET ?? 'stratum-dashboard-secret-change-in-prod'
  )
}

export async function POST(req) {
  const { email, password } = await req.json()

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password required' }, { status: 400 })
  }

  let proxyRes, data
  try {
    proxyRes = await fetch(`${GATEWAY}/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    })
    data = await proxyRes.json()
  } catch (err) {
    console.error('[session] gateway unreachable:', GATEWAY, err.message)
    return NextResponse.json(
      { error: `Cannot reach the gateway at ${GATEWAY}` },
      { status: 502 }
    )
  }

  if (!proxyRes.ok) {
    return NextResponse.json(
      { error: data.message ?? 'Invalid credentials' },
      { status: 401 }
    )
  }

  const session = await new SignJWT({
    token:    data.token,
    email:    data.user?.email,
    name:     data.user?.name,
    role:     data.user?.role,
    teamName: data.team?.name,
    teamId:   data.team?.id,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('24h')
    .sign(getSecret())

  const response = NextResponse.json({
    ok:       true,
    teamName: data.team?.name,
    role:     data.user?.role,
  })

  response.cookies.set('stratum_session', session, {
    httpOnly: true,
    secure:   process.env.SECURE_COOKIES === 'true', // set to 'true' only when HTTPS is enabled
    sameSite: 'lax',
    maxAge:   60 * 60 * 24,
    path:     '/',
  })

  return response
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true })
  response.cookies.delete('stratum_session')
  return response
}
