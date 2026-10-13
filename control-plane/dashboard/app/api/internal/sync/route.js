/**
 * GET /api/internal/sync
 *
 * Canal de sync DP → CP para el data plane de stratum.
 * Autenticado con Bearer sync_token (generado al registrar la instancia).
 *
 * Query params:
 *   since_version  — versión monotónica desde la que el DP quiere delta
 *   instance_id    — ID de la instancia (dp_xxxx)
 *
 * v2: incluye provider_configs (con api_key en claro — solo para sync autenticado).
 */

import { NextResponse } from 'next/server'
import { createHash, createDecipheriv } from 'crypto'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'

const SYNC_INTERVAL_S = parseInt(process.env.STRATUM_SYNC_INTERVAL_S ?? '30', 10)
const ENCRYPTION_KEY  = process.env.STRATUM_ENCRYPTION_KEY  // 32-byte hex (64 chars)

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function hashSyncToken(rawToken) {
  return createHash('sha256').update(rawToken).digest('hex')
}

async function authenticateInstance(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const rawToken = authHeader.slice(7)
  if (!rawToken) return null
  const tokenHash = hashSyncToken(rawToken)

  const rows = await query(
    `SELECT id, org_id, disabled
     FROM data_plane_instances
     WHERE sync_token_hash = $1 AND disabled = false
     LIMIT 1`,
    [tokenHash]
  )
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Decryption — AES-256-GCM
// Format stored: "<iv_hex>:<ciphertext_base64>"
// ---------------------------------------------------------------------------

function decryptApiKey(encryptedValue) {
  if (!ENCRYPTION_KEY) {
    throw new Error('STRATUM_ENCRYPTION_KEY not configured')
  }
  const [ivHex, ciphertextB64] = encryptedValue.split(':')
  if (!ivHex || !ciphertextB64) {
    throw new Error('Invalid encrypted format')
  }
  const key        = Buffer.from(ENCRYPTION_KEY, 'hex')
  const iv         = Buffer.from(ivHex, 'hex')
  const ciphertext = Buffer.from(ciphertextB64, 'base64')

  // AES-256-GCM: last 16 bytes are the auth tag
  const authTag    = ciphertext.slice(-16)
  const encrypted  = ciphertext.slice(0, -16)

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8')
}

// ---------------------------------------------------------------------------
// Version calculation (includes provider_configs)
// ---------------------------------------------------------------------------

async function getCurrentVersion() {
  const rows = await query(`
    SELECT GREATEST(
      COALESCE((SELECT MAX(version) FROM policies), 0),
      COALESCE((SELECT MAX(key_version) FROM users WHERE api_key_hash IS NOT NULL), 0),
      COALESCE((SELECT MAX(version) FROM provider_configs), 0)
    ) AS current_version
  `)
  return Number(rows[0]?.current_version ?? 0)
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(request) {
  const authHeader = request.headers.get('authorization')
  const instance   = await authenticateInstance(authHeader)

  if (!instance) {
    return NextResponse.json(
      { error: { type: 'authentication_error', message: 'Invalid or missing sync token.' } },
      { status: 401 }
    )
  }

  const { searchParams } = new URL(request.url)
  const sinceVersion = parseInt(searchParams.get('since_version') ?? '0', 10)
  const instanceId   = searchParams.get('instance_id') ?? ''

  if (instanceId && instanceId !== instance.id) {
    return NextResponse.json(
      { error: { type: 'permission_error', message: 'instance_id does not match token.' } },
      { status: 403 }
    )
  }

  const [currentVersion, policies, apiKeys, providerConfigsRaw] = await Promise.all([
    getCurrentVersion(),

    // Políticas delta
    query(`
      SELECT
        p.id,
        t.id                   AS team_id,
        p.version,
        p.updated_at,
        p.allowed_models,
        p.allow_all_models,
        p.monthly_token_quota,
        p.monthly_budget_usd,
        COALESCE(p.pii_action, 'off')    AS pii_action,
        COALESCE(p.dlp_action, 'off')    AS dlp_action,
        p.allowed_providers,
        COALESCE(p.revoked, false) AS revoked
      FROM policies p
      JOIN teams t ON t.policy_id = p.id
      WHERE p.version > $1
        AND p.org_id = $2
      ORDER BY p.version ASC
    `, [sinceVersion, instance.org_id]),

    // API keys delta
    query(`
      SELECT
        u.id,
        u.api_key_hash              AS key_hash,
        u.team_id,
        COALESCE(u.name, u.email)   AS label,
        u.key_version               AS version,
        u.created_at,
        COALESCE(u.key_revoked, false) AS revoked,
        u.key_revoked_at
      FROM users u
      JOIN teams t ON t.id = u.team_id
      WHERE u.api_key_hash IS NOT NULL
        AND u.key_version > $1
        AND t.org_id = $2
      ORDER BY u.key_version ASC
    `, [sinceVersion, instance.org_id]),

    // Provider configs delta
    query(`
      SELECT
        id,
        provider,
        display_name,
        api_key_encrypted,
        base_url,
        extra_config,
        enabled,
        version,
        COALESCE(revoked, false) AS revoked
      FROM provider_configs
      WHERE version > $1
        AND org_id = $2
      ORDER BY version ASC
    `, [sinceVersion, instance.org_id]),
  ])

  // Desencriptar API keys de proveedores para el payload de sync
  const providerConfigs = providerConfigsRaw.map(pc => {
    let apiKey = null
    if (!pc.revoked && pc.enabled) {
      try {
        apiKey = decryptApiKey(pc.api_key_encrypted)
      } catch (e) {
        console.error(`[sync] Failed to decrypt provider config ${pc.id}:`, e.message)
        return null
      }
    }
    return {
      id:           pc.id,
      provider:     pc.provider,
      display_name: pc.display_name,
      api_key:      apiKey,
      base_url:     pc.base_url ?? null,
      extra_config: pc.extra_config ?? {},
      enabled:      pc.enabled,
      version:      Number(pc.version),
      revoked:      pc.revoked,
    }
  }).filter(Boolean)

  // Heartbeat async
  query(`
    UPDATE data_plane_instances
    SET last_seen_at = now(),
        last_version = GREATEST(last_version, $1)
    WHERE id = $2
  `, [currentVersion, instance.id]).catch(err =>
    console.error('[sync] heartbeat update failed:', err)
  )

  // node-postgres returns BIGINT and DECIMAL as strings. The sync contract
  // (api/sync/v2/sync-response.schema.json) uses JSON numbers.
  const num = v => (v === null || v === undefined ? null : Number(v))

  return NextResponse.json({
    current_version:      currentVersion,
    next_sync_in_seconds: SYNC_INTERVAL_S,
    policies: policies.map(p => ({
      ...p,
      version:             num(p.version),
      monthly_token_quota: num(p.monthly_token_quota),
      monthly_budget_usd:  num(p.monthly_budget_usd),
    })),
    api_keys: apiKeys.map(k => ({ ...k, version: num(k.version) })),
    provider_configs:     providerConfigs,
  })
}
