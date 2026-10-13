/**
 * GET    /api/internal/providers   — listar provider configs de la org
 * POST   /api/internal/providers   — agregar/actualizar provider config
 * DELETE /api/internal/providers?id=pc_xxx — revocar provider config
 *
 * Autenticación: dashboard JWT (stratum_session cookie) via requireAuth.
 *
 * Las API keys se almacenan cifradas (AES-256-GCM).
 * NUNCA se devuelven en claro — solo un indicador de si están configuradas.
 */

import { NextResponse } from 'next/server'
import { createCipheriv, randomBytes } from 'crypto'
import { query }       from '@/lib/db'
import { requireAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const ENCRYPTION_KEY  = process.env.STRATUM_ENCRYPTION_KEY  // 32-byte hex (64 chars)

const VALID_PROVIDERS = new Set([
  'openai', 'anthropic', 'gemini', 'google',
  'groq', 'azure', 'ollama', 'mistral',
  'cohere', 'deepseek', 'xai',
])

// ---------------------------------------------------------------------------
// Encryption helpers — AES-256-GCM
// ---------------------------------------------------------------------------

function encryptApiKey(plaintext) {
  if (!ENCRYPTION_KEY) {
    throw new Error('STRATUM_ENCRYPTION_KEY not configured')
  }
  const key = Buffer.from(ENCRYPTION_KEY, 'hex')
  const iv  = randomBytes(12)  // 96-bit IV recommended for GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),  // 16 bytes appended
  ])
  return `${iv.toString('hex')}:${encrypted.toString('base64')}`
}

// ---------------------------------------------------------------------------
// GET — list providers for the org (no api_keys in plaintext)
// ---------------------------------------------------------------------------

export async function GET(request) {
  const user = await requireAuth(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const providers = await query(`
    SELECT
      id,
      provider,
      display_name,
      base_url,
      extra_config,
      enabled,
      revoked,
      version,
      updated_at,
      CASE WHEN api_key_encrypted IS NOT NULL THEN true ELSE false END AS has_api_key
    FROM provider_configs
    WHERE org_id = $1
      AND revoked = false
    ORDER BY provider, display_name
  `, [user.org_id])

  return NextResponse.json({ providers })
}

// ---------------------------------------------------------------------------
// POST — create or update provider config
// ---------------------------------------------------------------------------

export async function POST(request) {
  const user = await requireAuth(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { provider, display_name, api_key, base_url, extra_config } = body

  if (!provider || typeof provider !== 'string') {
    return NextResponse.json({ error: 'provider is required' }, { status: 400 })
  }
  if (!VALID_PROVIDERS.has(provider)) {
    return NextResponse.json(
      { error: `Unknown provider. Valid: ${[...VALID_PROVIDERS].join(', ')}` },
      { status: 400 }
    )
  }
  if (!api_key || typeof api_key !== 'string' || api_key.trim().length === 0) {
    return NextResponse.json({ error: 'api_key is required' }, { status: 400 })
  }
  if (!display_name || typeof display_name !== 'string') {
    return NextResponse.json({ error: 'display_name is required' }, { status: 400 })
  }

  let encryptedKey
  try {
    encryptedKey = encryptApiKey(api_key.trim())
  } catch {
    return NextResponse.json(
      { error: 'Encryption failed. Check STRATUM_ENCRYPTION_KEY.' },
      { status: 500 }
    )
  }

  const id = `pc_${randomBytes(16).toString('hex')}`

  // UPSERT: if non-revoked config for this org+provider exists, update it
  const existing = await query(`
    SELECT id FROM provider_configs
    WHERE org_id = $1 AND provider = $2 AND revoked = false
    LIMIT 1
  `, [user.org_id, provider])

  let result
  if (existing.length > 0) {
    // Update (trigger bumps version)
    result = await query(`
      UPDATE provider_configs
      SET
        display_name      = $3,
        api_key_encrypted = $4,
        base_url          = $5,
        extra_config      = $6::jsonb,
        enabled           = true
      WHERE id = $1 AND org_id = $2
      RETURNING id, provider, display_name, enabled, version
    `, [
      existing[0].id, user.org_id,
      display_name.trim(),
      encryptedKey,
      base_url ?? null,
      JSON.stringify(extra_config ?? {}),
    ])
  } else {
    // Insert new
    result = await query(`
      INSERT INTO provider_configs
        (id, org_id, provider, display_name, api_key_encrypted, base_url, extra_config)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING id, provider, display_name, enabled, version
    `, [
      id, user.org_id,
      provider, display_name.trim(),
      encryptedKey,
      base_url ?? null,
      JSON.stringify(extra_config ?? {}),
    ])
  }

  return NextResponse.json(result[0], { status: existing.length > 0 ? 200 : 201 })
}

// ---------------------------------------------------------------------------
// DELETE — revoke provider config (soft-delete, bumps version for sync)
// ---------------------------------------------------------------------------

export async function DELETE(request) {
  const user = await requireAuth(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')

  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  const rows = await query(`
    UPDATE provider_configs
    SET revoked = true
    WHERE id = $1 AND org_id = $2 AND revoked = false
    RETURNING id, provider
  `, [id, user.org_id])

  if (rows.length === 0) {
    return NextResponse.json({ error: 'Provider config not found' }, { status: 404 })
  }

  return NextResponse.json({ revoked: id, provider: rows[0].provider })
}
