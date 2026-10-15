/**
 * GET    /api/internal/providers   — listar provider configs de la org
 * POST   /api/internal/providers   — agregar/actualizar provider config
 * DELETE /api/internal/providers?id=pc_xxx — revocar provider config
 *
 * Console session routes (lib/route.js): providers.read / providers.manage.
 *
 * Las API keys se almacenan cifradas (AES-256-GCM).
 * NUNCA se devuelven en claro — solo un indicador de si están configuradas.
 */

import { createCipheriv, randomBytes } from 'crypto'
import { route, readJson, json, badRequest, notFound, HttpError } from '@/lib/route'
import { audit } from '@/lib/audit'

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

export const GET = route('providers.read', async (req, { session, db }) => {
  const { rows: providers } = await db.query(`
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
  `, [session.orgId])

  return json({ providers })
})

// ---------------------------------------------------------------------------
// POST — create or update provider config
// ---------------------------------------------------------------------------

export const POST = route('providers.manage', async (req, { session, db }) => {
  const body = await readJson(req)

  const { provider, display_name, api_key, base_url, extra_config } = body

  if (!provider || typeof provider !== 'string') throw badRequest('provider is required')
  if (!VALID_PROVIDERS.has(provider)) {
    throw badRequest(`Unknown provider. Valid: ${[...VALID_PROVIDERS].join(', ')}`)
  }
  if (!api_key || typeof api_key !== 'string' || api_key.trim().length === 0) throw badRequest('api_key is required')
  if (!display_name || typeof display_name !== 'string' || !display_name.trim()) throw badRequest('display_name is required')
  if (base_url != null && (typeof base_url !== 'string' || !/^https?:\/\//.test(base_url))) {
    throw badRequest('base_url must be an http(s) URL')
  }

  let encryptedKey
  try {
    encryptedKey = encryptApiKey(api_key.trim())
  } catch {
    throw new HttpError(500, 'encryption_failed', 'Encryption failed. Check STRATUM_ENCRYPTION_KEY.')
  }

  const id = `pc_${randomBytes(16).toString('hex')}`

  // UPSERT: if non-revoked config for this org+provider exists, update it
  const { rows: existing } = await db.query(`
    SELECT id FROM provider_configs
    WHERE org_id = $1 AND provider = $2 AND revoked = false
    LIMIT 1
  `, [session.orgId, provider])

  let result
  if (existing.length > 0) {
    // Update (trigger bumps version)
    ;({ rows: result } = await db.query(`
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
      existing[0].id, session.orgId,
      display_name.trim(),
      encryptedKey,
      base_url ?? null,
      JSON.stringify(extra_config ?? {}),
    ]))
  } else {
    // Insert new
    ;({ rows: result } = await db.query(`
      INSERT INTO provider_configs
        (id, org_id, provider, display_name, api_key_encrypted, base_url, extra_config)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING id, provider, display_name, enabled, version
    `, [
      id, session.orgId,
      provider, display_name.trim(),
      encryptedKey,
      base_url ?? null,
      JSON.stringify(extra_config ?? {}),
    ]))
  }

  await audit(db, {
    req, session, action: existing.length > 0 ? 'provider.update' : 'provider.create',
    targetType: 'provider_config', targetId: result[0].id,
    details: { provider, displayName: display_name.trim(), baseUrl: base_url ?? null, credentialReplaced: true },
  })
  return json(result[0], existing.length > 0 ? 200 : 201)
})

// ---------------------------------------------------------------------------
// DELETE — revoke provider config (soft-delete, bumps version for sync)
// ---------------------------------------------------------------------------

export const DELETE = route('providers.manage', async (req, { session, db }) => {
  const id = new URL(req.url).searchParams.get('id')
  if (!id) throw badRequest('id is required')

  const { rows } = await db.query(`
    UPDATE provider_configs
    SET revoked = true
    WHERE id = $1 AND org_id = $2 AND revoked = false
    RETURNING id, provider
  `, [id, session.orgId])
  if (rows.length === 0) throw notFound('Provider config not found')

  await audit(db, { req, session, action: 'provider.revoke', targetType: 'provider_config', targetId: id, details: { provider: rows[0].provider } })
  return json({ revoked: id, provider: rows[0].provider })
})
