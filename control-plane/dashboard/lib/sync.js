/**
 * Builds the body of GET /api/internal/sync (contract:
 * api/sync/v2/sync-response.schema.json) for one organisation.
 *
 * Every change that affects what a gateway allows has a version from
 * stratum_version_seq (migrations 012-017), so a delta (since_version > 0)
 * carries it within one sync interval:
 *   - api keys of users and of agents ("agent:<uuid>", migration 017):
 *     rotated, revoked, removed, deactivated or moved; a key
 *     that no longer works is sent with revoked = true (removed keys with an
 *     empty key_hash), never left out;
 *   - policies, per team: the policy changed, or the team got another policy
 *     or none (sent as revoked: the team is disabled);
 *   - the people directory (migration 028): who a key that delegates may
 *     act for, and with which team;
 *   - provider configs;
 *   - with every sync, unversioned: the models the organization can use
 *     (GET /v1/models) and each team's usage this month;
 *   - deletions, from stratum_sync_tombstones.
 *
 * All reads run in one REPEATABLE READ transaction, so current_version and
 * the rows come from the same snapshot of the database. Otherwise a row
 * committed between two queries could be counted in current_version but not
 * returned, and the gateway would skip it until its next full resync. A row
 * whose version was taken before a higher one but committed after it can
 * still be missed by a delta; the gateway's periodic full resync covers that
 * (ADR-0003).
 */

// How long a full sync (since_version = 0) keeps sending removed keys and
// deleted objects as revocations. Gateways that have them drop them; the
// gateway's guard counts them as explicit revocations instead of keys that
// silently vanished. Deltas always include them.
const FULL_SYNC_TOMBSTONE_DAYS = 30

/**
 * @param {import('pg').PoolClient} client  a dedicated connection
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {number} opts.sinceVersion       0 = full sync
 * @param {number} opts.syncIntervalS
 * @param {(encrypted: string) => string} opts.decrypt  provider key decryption
 * @param {(msg: string) => void} [opts.warn]
 */
export async function buildSyncResponse(client, { orgId, sinceVersion, syncIntervalS, decrypt, warn = console.error }) {
  const since = Number.isFinite(sinceVersion) && sinceVersion > 0 ? sinceVersion : 0
  const q = async (sql, params) => (await client.query(sql, params)).rows

  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  let version, policies, apiKeys, people, providerConfigs, tombstones, usage, usageMonth, models
  try {
    ;[{ v: version }] = await q('SELECT stratum_sync_version($1)::bigint AS v', [orgId])

    // One entry per team: what the gateway enforces is keyed by team. The
    // version is the newer of the policy's and the team's assignment, so a
    // team moved to an older policy still replaces what the gateway has.
    policies = await q(`
      SELECT
        COALESCE(p.id::text, '')                         AS id,
        t.id::text                                       AS team_id,
        GREATEST(COALESCE(p.version, 0), t.policy_version) AS version,
        p.updated_at,
        -- Every ID of each model the policy names (migration 023).
        stratum_expand_models(p.allowed_models)          AS allowed_models,
        COALESCE(p.allow_all_models, false)              AS allow_all_models,
        -- Models the organization turned off (migration 024): refused even
        -- under "all models".
        stratum_org_denied_models($2)                    AS denied_models,
        p.monthly_token_quota,
        -- What gateways enforce (migration 026): the team's own budget or
        -- the policy's, only when the policy cuts at the budget.
        CASE WHEN COALESCE(p.budget_enforced, false)
             THEN COALESCE(t.monthly_budget_usd, p.monthly_budget_usd) END AS monthly_budget_usd,
        p.max_tokens_per_request,
        -- Instructions for people (migration 031); gateways before 0.3 ignore them.
        COALESCE(p.people_instructions, '')              AS people_instructions,
        COALESCE(p.pii_action, 'off')                    AS pii_action,
        COALESCE(p.dlp_action, 'off')                    AS dlp_action,
        p.allowed_providers,
        (p.id IS NULL OR COALESCE(p.revoked, false))     AS revoked
      FROM teams t
      LEFT JOIN policies p ON p.id = t.policy_id
      WHERE t.org_id = $2
        AND GREATEST(COALESCE(p.version, 0), t.policy_version) > $1
      ORDER BY 3 ASC
    `, [since, orgId])

    apiKeys = await q(`
      SELECT
        u.id::text                                  AS id,
        COALESCE(u.api_key_hash, '')                AS key_hash,
        COALESCE(u.team_id::text, '')               AS team_id,
        COALESCE(u.name, u.email)                   AS label,
        u.key_version                               AS version,
        u.created_at,
        (u.api_key_hash IS NULL
          OR COALESCE(u.key_revoked, false)
          OR NOT COALESCE(u.is_active, true)
          OR u.team_id IS NULL)                     AS revoked,
        u.key_revoked_at,
        NULL::text                                  AS default_provider,
        NULL::text                                  AS default_model,
        false                                       AS delegates
      FROM users u
      WHERE u.org_id = $2
        AND u.key_version > $1
        AND (u.api_key_hash IS NOT NULL
             OR (u.key_revoked_at IS NOT NULL
                 AND ($1 > 0 OR u.key_revoked_at > now() - make_interval(days => $3))))
      UNION ALL
      -- Agent keys (migration 017), under ids that cannot collide with users'.
      SELECT
        'agent:' || a.id::text                      AS id,
        COALESCE(a.api_key_hash, '')                AS key_hash,
        COALESCE(a.team_id::text, '')               AS team_id,
        a.name                                      AS label,
        a.key_version                               AS version,
        a.created_at,
        (a.api_key_hash IS NULL
          OR NOT COALESCE(a.is_active, true)
          OR a.team_id IS NULL)                     AS revoked,
        a.key_revoked_at,
        NULLIF(a.default_provider, '')              AS default_provider,
        NULLIF(a.default_model, '')                 AS default_model,
        -- Its key may act for a person (X-Stratum-User, migration 028).
        COALESCE(a.delegates, false)                AS delegates
      FROM agents a
      WHERE a.org_id = $2
        AND a.key_version > $1
        AND (a.api_key_hash IS NOT NULL
             OR (a.key_revoked_at IS NOT NULL
                 AND ($1 > 0 OR a.key_revoked_at > now() - make_interval(days => $3))))
      ORDER BY version ASC
    `, [since, orgId, FULL_SYNC_TOMBSTONE_DAYS])

    // The people directory (migration 028): who keys that delegate may act
    // for, and under which team. Ids only, never names or emails. A full
    // sync sends everyone; a delta, whoever changed (users.key_version
    // moves with team_id, is_active and app_access).
    people = await q(`
      SELECT u.id::text                              AS id,
             COALESCE(u.team_id::text, '')           AS team_id,
             u.key_version                           AS version,
             (NOT COALESCE(u.is_active, true)
               OR NOT COALESCE(u.app_access, true)
               OR u.team_id IS NULL)                 AS revoked
        FROM users u
       WHERE u.org_id = $2 AND u.key_version > $1
       ORDER BY version ASC
    `, [since, orgId])

    providerConfigs = await q(`
      SELECT id::text AS id, provider, display_name, api_key_encrypted, base_url,
             extra_config, enabled, version, COALESCE(revoked, false) AS revoked
      FROM provider_configs
      WHERE org_id = $2 AND version > $1
      ORDER BY version ASC
    `, [since, orgId])

    tombstones = await q(`
      SELECT kind, object_id, provider, version
      FROM stratum_sync_tombstones
      WHERE org_id = $2 AND version > $1
        AND ($1 > 0 OR deleted_at > now() - make_interval(days => $3))
      ORDER BY version ASC
    `, [since, orgId, FULL_SYNC_TOMBSTONE_DAYS])

    // Each team's usage this month (migration 026), with every sync: not
    // versioned. Gateways use it as a floor for quotas and for budgets.
    ;[{ m: usageMonth }] = await q(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM') AS m`)
    usage = await q(`
      SELECT team_id::text AS team_id, tokens, cost_usd
        FROM team_usage_monthly
       WHERE org_id = $1 AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
       ORDER BY team_id
    `, [orgId])

    // The models the organization can use, for GET /v1/models on gateways:
    // catalog models it did not turn off, and models a provider listed for
    // it that the catalog lacks, of providers it configured. Sent with
    // every sync (not versioned); each gateway lists the ones a policy
    // allows.
    models = await q(`
      SELECT m.provider, m.model_id AS id, m.display_name AS name
        FROM ai_models m
        LEFT JOIN org_model_settings s
          ON s.org_id = $1 AND s.provider = m.provider AND s.model_id = m.model_id
       WHERE COALESCE(m.is_active, true) AND COALESCE(s.enabled, true)
         AND (m.deprecated_on IS NULL OR m.deprecated_on > now()::date)
         AND EXISTS (SELECT 1 FROM provider_configs pc
                      WHERE pc.org_id = $1 AND pc.provider = m.provider
                        AND COALESCE(pc.enabled, false) AND NOT COALESCE(pc.revoked, false))
      UNION ALL
      SELECT pm.provider, pm.model_id, NULL
        FROM provider_models pm
        LEFT JOIN org_model_settings s
          ON s.org_id = pm.org_id AND s.provider = pm.provider AND s.model_id = pm.model_id
       WHERE pm.org_id = $1 AND COALESCE(s.enabled, true)
         AND NOT EXISTS (SELECT 1 FROM ai_models m
                          WHERE m.provider = pm.provider
                            AND (m.model_id = pm.model_id OR pm.model_id = ANY(m.aliases)))
         AND EXISTS (SELECT 1 FROM provider_configs pc
                      WHERE pc.org_id = $1 AND pc.provider = pm.provider
                        AND COALESCE(pc.enabled, false) AND NOT COALESCE(pc.revoked, false))
       ORDER BY 1, 2
    `, [orgId])

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }

  // node-postgres returns BIGINT and DECIMAL as strings; the contract uses
  // JSON numbers.
  const num = v => (v === null || v === undefined ? null : Number(v))

  const out = {
    current_version:      num(version),
    next_sync_in_seconds: syncIntervalS,
    policies: policies.map(p => ({
      ...p,
      version:             num(p.version),
      monthly_token_quota: num(p.monthly_token_quota),
      monthly_budget_usd:  num(p.monthly_budget_usd),
      max_tokens_per_request: num(p.max_tokens_per_request),
    })),
    api_keys: apiKeys.map(k => ({ ...k, version: num(k.version) })),
    people: people.map(p => ({ ...p, version: num(p.version) })),
    provider_configs: providerConfigs.map(pc => {
      let apiKey = null
      if (!pc.revoked && pc.enabled) {
        try {
          apiKey = decrypt(pc.api_key_encrypted)
        } catch (e) {
          warn(`[sync] cannot decrypt provider config ${pc.id}: ${e.message}`)
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
        version:      num(pc.version),
        revoked:      pc.revoked,
      }
    }).filter(Boolean),
    models: models.map(m => (m.name ? m : { provider: m.provider, id: m.id })),
    month_usage: {
      month: usageMonth,
      teams: usage.map(u => ({ team_id: u.team_id, tokens: num(u.tokens), cost_usd: num(u.cost_usd) })),
    },
  }

  for (const t of tombstones) {
    const v = num(t.version)
    if (t.kind === 'api_key') {
      out.api_keys.push({ id: t.object_id, key_hash: '', team_id: '', label: null, version: v, created_at: null, revoked: true, key_revoked_at: null })
    } else if (t.kind === 'team') {
      out.policies.push({
        id: '', team_id: t.object_id, version: v, updated_at: null,
        allowed_models: [], allow_all_models: false, monthly_token_quota: null, monthly_budget_usd: null,
        max_tokens_per_request: null, people_instructions: '',
        pii_action: 'off', dlp_action: 'off', allowed_providers: null, revoked: true,
      })
    } else if (t.kind === 'person') {
      out.people.push({ id: t.object_id, team_id: '', version: v, revoked: true })
    } else if (t.kind === 'provider_config') {
      out.provider_configs.push({
        id: t.object_id, provider: t.provider || 'unknown', display_name: null, api_key: null,
        base_url: null, extra_config: {}, enabled: false, version: v, revoked: true,
      })
    }
    // 'policy': only keeps current_version from going backwards.
  }
  return out
}
