/**
 * Provider configurations of the session's organization (provider_configs:
 * what gateways read in the sync).
 *
 * GET    /api/internal/providers            — list; never a credential, only its last 4 characters
 * POST   /api/internal/providers            — add one, or replace the one for that provider
 * PATCH  /api/internal/providers?id=pc_...  — change name, address, enabled, or the credential
 * DELETE /api/internal/providers?id=pc_...  — revoke: the credential is discarded, gateways drop it in the next sync
 *
 * Credentials are stored encrypted (lib/secrets.js) and never returned.
 */

import { route, readJson, json, badRequest, notFound, conflict, HttpError } from '@/lib/route'
import { audit } from '@/lib/audit'
import { encryptSecret, secretHint } from '@/lib/secrets'
import { describe, providerName, baseUrl, extraConfig, testable, PROVIDERS } from '@/lib/providers'
import { randomBytes } from 'crypto'

export const dynamic = 'force-dynamic'

const COLUMNS = `id, provider, display_name, base_url, extra_config, enabled, version, updated_at,
                 api_key_hint, key_updated_by, key_updated_at`

function encrypt(value) {
  try {
    return encryptSecret(value)
  } catch {
    throw new HttpError(500, 'encryption_failed', 'No se pudo cifrar la credencial: revisá STRATUM_ENCRYPTION_KEY.')
  }
}

function credential(value, info, { required }) {
  if (value == null || value === '') {
    if (required && info.key) throw badRequest('La API key es obligatoria para este proveedor.')
    return null
  }
  if (typeof value !== 'string' || value.trim().length > 4096) throw badRequest('API key inválida.')
  return value.trim()
}

function displayName(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value !== 'string' || !value.trim()) throw badRequest('Nombre inválido.')
  return value.trim().slice(0, 100)
}

function withLabels(row) {
  const info = describe(row.provider)
  return {
    ...row,
    provider_label: info?.label ?? row.provider,
    protocol: info?.protocol ?? 'openai',
    default_base_url: info?.base ?? null,
    testable: testable(row.provider, row.base_url),
  }
}

export const GET = route('providers.read', async (req, { session, db }) => {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM provider_configs
      WHERE org_id = $1 AND revoked = false
      ORDER BY display_name`,
    [session.orgId])
  return json({
    providers: rows.map(withLabels),
    presets: Object.entries(PROVIDERS).map(([id, p]) => ({
      id, label: p.label, protocol: p.protocol, base: p.base, keyRequired: p.key,
      category: p.category, free: p.free, docs: p.docs, testable: testable(id),
    })),
  })
})

export const POST = route('providers.manage', async (req, { session, db }) => {
  const body = await readJson(req)
  const provider = providerName(body.provider)
  const info = describe(provider)
  const key = credential(body.api_key, info, { required: true })
  const values = {
    display_name: displayName(body.display_name, info.custom ? provider.slice('custom-'.length) : info.label),
    base_url:     baseUrl(body.base_url, info),
    extra_config: extraConfig(body.extra_config, provider),
  }

  // One active configuration per provider: this replaces it (the unique
  // index idx_provider_configs_org_provider from migration 013 backs this up).
  const { rows: existing } = await db.query(
    'SELECT id FROM provider_configs WHERE org_id = $1 AND provider = $2 AND revoked = false',
    [session.orgId, provider])

  let row
  try {
    if (existing[0]) {
      ;({ rows: [row] } = await db.query(
        `UPDATE provider_configs
            SET display_name = $3, api_key_encrypted = $4, base_url = $5, extra_config = $6::jsonb,
                enabled = true, api_key_hint = $7, key_updated_by = $8, key_updated_at = now()
          WHERE id = $1 AND org_id = $2
          RETURNING ${COLUMNS}`,
        [existing[0].id, session.orgId, values.display_name, encrypt(key ?? ''), values.base_url,
         JSON.stringify(values.extra_config), secretHint(key), session.email]))
    } else {
      ;({ rows: [row] } = await db.query(
        `INSERT INTO provider_configs
           (id, org_id, provider, display_name, api_key_encrypted, base_url, extra_config,
            api_key_hint, key_updated_by, key_updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, now())
         RETURNING ${COLUMNS}`,
        [`pc_${randomBytes(16).toString('hex')}`, session.orgId, provider, values.display_name, encrypt(key ?? ''),
         values.base_url, JSON.stringify(values.extra_config), secretHint(key), session.email]))
    }
  } catch (err) {
    if (err.code === '23505') throw conflict('Otra persona configuró este proveedor recién. Recargá la página.')
    throw err
  }

  await audit(db, {
    req, session, action: existing[0] ? 'provider.replace' : 'provider.create',
    targetType: 'provider_config', targetId: row.id,
    details: { provider, displayName: values.display_name, baseUrl: values.base_url, credential: key ? 'set' : 'none' },
  })
  return json(withLabels(row), existing[0] ? 200 : 201)
})

export const PATCH = route('providers.manage', async (req, { session, db }) => {
  const id = new URL(req.url).searchParams.get('id')
  if (!id) throw badRequest('id es obligatorio.')
  const { rows: [cur] } = await db.query(
    'SELECT id, provider FROM provider_configs WHERE id = $1 AND org_id = $2 AND revoked = false', [id, session.orgId])
  if (!cur) throw notFound('Proveedor no encontrado.')
  const info = describe(cur.provider) ?? { label: cur.provider, protocol: 'openai', base: null, key: false, custom: true }
  const body = await readJson(req)

  const fields = []
  const values = []
  const changed = []
  const set = (col, val, label) => { values.push(val); fields.push(`${col} = $${values.length}`); if (label) changed.push(label) }

  if (body.display_name !== undefined) set('display_name', displayName(body.display_name, info.label), 'displayName')
  if (body.base_url !== undefined) set('base_url', baseUrl(body.base_url, info), 'baseUrl')
  if (body.extra_config !== undefined) set('extra_config', JSON.stringify(extraConfig(body.extra_config, cur.provider)), 'extraConfig')
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw badRequest('enabled tiene que ser true o false.')
    set('enabled', body.enabled, 'enabled')
  }
  if (body.api_key !== undefined) {
    const key = credential(body.api_key, info, { required: true })
    set('api_key_encrypted', encrypt(key ?? ''), 'credential')
    set('api_key_hint', secretHint(key))
    set('key_updated_by', session.email)
    fields.push('key_updated_at = now()')
  }
  if (!changed.length) throw badRequest('Nada para actualizar.')

  values.push(id, session.orgId)
  const { rows: [row] } = await db.query(
    `UPDATE provider_configs SET ${fields.join(', ')}
      WHERE id = $${values.length - 1} AND org_id = $${values.length} AND revoked = false
      RETURNING ${COLUMNS}`,
    values)
  if (!row) throw notFound('Proveedor no encontrado.')
  await audit(db, {
    req, session, action: 'provider.update', targetType: 'provider_config', targetId: id,
    details: { provider: cur.provider, changed, ...(body.enabled !== undefined ? { enabled: body.enabled } : {}) },
  })
  return json(withLabels(row))
})

export const DELETE = route('providers.manage', async (req, { session, db }) => {
  const id = new URL(req.url).searchParams.get('id')
  if (!id) throw badRequest('id es obligatorio.')
  const { rows } = await db.query(
    `UPDATE provider_configs SET revoked = true, api_key_encrypted = '', api_key_hint = NULL
      WHERE id = $1 AND org_id = $2 AND revoked = false
      RETURNING id, provider`,
    [id, session.orgId])
  if (!rows[0]) throw notFound('Proveedor no encontrado.')
  await audit(db, { req, session, action: 'provider.revoke', targetType: 'provider_config', targetId: id, details: { provider: rows[0].provider } })
  return json({ revoked: id, provider: rows[0].provider })
})
