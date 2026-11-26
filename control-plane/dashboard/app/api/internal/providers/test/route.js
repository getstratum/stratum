/**
 * POST /api/internal/providers/test  { id }            — test a saved configuration
 * POST /api/internal/providers/test  { provider, api_key } — test before saving
 *
 * Lists the provider's models from the control plane. Only known providers at
 * their own address (lib/providers.js testable): the control plane never calls
 * an address someone typed.
 */

import { route, readJson, json, badRequest, notFound } from '@/lib/route'
import { audit } from '@/lib/audit'
import { decryptSecret } from '@/lib/secrets'
import { providerName, testConnection, testable } from '@/lib/providers'
import { storeListed } from '@/lib/provider-models'

export const dynamic = 'force-dynamic'

export const POST = route('providers.manage', async (req, { session, db }) => {
  const body = await readJson(req)
  let provider, apiKey, id = null
  if (body.id) {
    const { rows: [pc] } = await db.query(
      `SELECT id, provider, base_url, api_key_encrypted FROM provider_configs
        WHERE id = $1 AND org_id = $2 AND revoked = false`,
      [body.id, session.orgId])
    if (!pc) throw notFound('Proveedor no encontrado.')
    if (!testable(pc.provider, pc.base_url)) return json({ ok: false, ms: 0, message: 'Con una URL propia, se prueba desde un gateway.' })
    provider = pc.provider
    try {
      apiKey = decryptSecret(pc.api_key_encrypted)
    } catch {
      return json({ ok: false, ms: 0, message: 'No se pudo descifrar la credencial guardada (¿cambió STRATUM_ENCRYPTION_KEY?). Reemplazala.' })
    }
    id = pc.id
  } else {
    provider = providerName(body.provider)
    if (body.base_url) return json({ ok: false, ms: 0, message: 'Con una URL propia, se prueba desde un gateway.' })
    if (typeof body.api_key !== 'string' || !body.api_key.trim()) throw badRequest('La API key es obligatoria.')
    apiKey = body.api_key.trim()
  }

  const result = await testConnection(provider, apiKey)
  // The models the provider listed become choosable in policies, also those
  // the catalog does not have (migration 024: they have no price).
  // With the kind the provider said, when it said one (lib/model-kind.js),
  // and whether they read images and call tools (lib/model-capabilities.js).
  await storeListed(db, session.orgId, provider, result)
  await audit(db, {
    req, session, action: 'provider.test', targetType: 'provider_config', targetId: id,
    result: result.ok ? 'ok' : 'failed', details: { provider, status: result.status ?? null },
  })
  return json(result)
})
