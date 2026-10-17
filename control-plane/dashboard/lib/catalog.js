/**
 * lib/catalog.js — what a policy allows, as gateways decide it, for showing
 * it in the console. Works on rows as the API returns them: a policy (or a
 * team joined with its policy) with allow_all_models, allowed_models and
 * allowed_providers; a catalog model with provider, model_id and aliases.
 *
 * Gateways compare names exactly against the policy's list, expanded by the
 * sync with every ID of each catalog model it names (migration 023): a model
 * is allowed when any of its IDs is listed, bare or as "provider/id".
 */

/** Every name a gateway accepts for `model`. */
export function namesOf(model) {
  const ids = [model.model_id, ...(model.aliases ?? [])]
  return [...ids, ...ids.map(id => `${model.provider}/${id}`)]
}

/** Whether `policy` lets a request use catalog `model`. */
export function allowedBy(policy, model) {
  if (!policy) return false
  const providers = policy.allowed_providers ?? []
  if (providers.length > 0 && !providers.includes(model.provider)) return false
  if (policy.allow_all_models) return true
  const listed = new Set(policy.allowed_models ?? [])
  return namesOf(model).some(n => listed.has(n))
}
