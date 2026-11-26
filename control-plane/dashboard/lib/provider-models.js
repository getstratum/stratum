/**
 * lib/provider-models.js — the models each organization's providers offer
 * (provider_models, migration 024), kept current.
 *
 * "Probar" in Proveedores lists them once; from 1.0 the control plane also
 * lists them every day, for every enabled provider of every active
 * organization that it can test from here (lib/providers.js testable: a
 * known provider at its own address, never an address someone typed). A
 * model a provider no longer lists keeps its row, with the day it was last
 * seen: policies that name it do not change behind anyone's back.
 *
 * Several control plane replicas listing at once only write the same rows.
 */

import { decryptSecret } from './secrets.js'
import { testConnection, testable } from './providers.js'

/** Stores what one provider listed for an organization. Returns how many rows. */
export async function storeListed(db, orgId, provider, result) {
  if (!result?.ok || !result.ids?.length) return 0
  const { rowCount } = await db.query(
    `INSERT INTO provider_models (org_id, provider, model_id, kind, vision, tools, seen_at)
     SELECT $1, $2, l.id, l.kind, l.vision, l.tools, now()
       FROM unnest($3::text[], $4::text[], $5::boolean[], $6::boolean[]) AS l(id, kind, vision, tools)
      WHERE l.id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$'
     ON CONFLICT (org_id, provider, model_id) DO UPDATE
       SET kind = EXCLUDED.kind, vision = EXCLUDED.vision, tools = EXCLUDED.tools, seen_at = now()`,
    [orgId, provider, result.ids, result.ids.map(id => result.kinds?.[id] ?? null),
     result.ids.map(id => result.capabilities?.[id]?.vision ?? null), result.ids.map(id => result.capabilities?.[id]?.tools ?? null)])
  return rowCount
}

/**
 * Lists the models of every enabled provider of every active organization.
 * Never throws for one provider: its failure is in the result, and the next
 * day tries again.
 *
 * @returns {Promise<Array<{ orgId, provider, ok, models?, message? }>>}
 */
export async function refreshProviderModels(db, { test = testConnection } = {}) {
  const { rows } = await db.query(
    `SELECT pc.org_id::text AS org_id, pc.provider, pc.base_url, pc.api_key_encrypted
       FROM provider_configs pc JOIN organizations o ON o.id = pc.org_id
      WHERE pc.enabled AND NOT pc.revoked AND o.status = 'active' AND o.delete_after IS NULL
      ORDER BY pc.org_id, pc.provider`)
  const results = []
  for (const pc of rows) {
    if (!testable(pc.provider, pc.base_url)) continue
    let key
    try {
      key = decryptSecret(pc.api_key_encrypted)
    } catch {
      results.push({ orgId: pc.org_id, provider: pc.provider, ok: false, message: 'cannot decrypt the stored key' })
      continue
    }
    const r = await test(pc.provider, key).catch(err => ({ ok: false, message: err.message }))
    if (!r.ok) {
      results.push({ orgId: pc.org_id, provider: pc.provider, ok: false, message: r.message ?? `status ${r.status ?? '?'}` })
      continue
    }
    results.push({ orgId: pc.org_id, provider: pc.provider, ok: true, models: await storeListed(db, pc.org_id, pc.provider, r) })
  }
  return results
}
