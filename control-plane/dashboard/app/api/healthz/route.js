import { NextResponse } from 'next/server'
import { publicRoute } from '../../../lib/route.js'

export const dynamic = 'force-dynamic'

export const GET = publicRoute(async () => NextResponse.json({ ok: true }))
