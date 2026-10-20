/**
 * lib/policies.js — validation of the policy fields the console edits.
 */

import { badRequest } from './route.js'
import { describe } from './providers.js'

function optionalNumber(v, label, { integer = false } = {}) {
  if (v === undefined || v === null) return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) throw badRequest(`${label} inválido.`)
  return n
}

/** The editable fields present in `body`, validated. Absent fields are undefined. */
export function policyFields(body) {
  const out = {}
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw badRequest('Nombre inválido.')
    out.name = body.name.trim().slice(0, 255)
  }
  if (body.allowedModels !== undefined) {
    if (!Array.isArray(body.allowedModels) || body.allowedModels.some(m => typeof m !== 'string' || !m || m.length > 200)) {
      throw badRequest('allowedModels tiene que ser una lista de nombres de modelo.')
    }
    out.allowedModels = [...new Set(body.allowedModels)]
  }
  if (body.allowAllModels !== undefined) {
    if (typeof body.allowAllModels !== 'boolean') throw badRequest('allowAllModels tiene que ser true o false.')
    out.allowAllModels = body.allowAllModels
  }
  // Gateways refuse the teams' requests once the month's spend reaches the
  // budget (from 0.3); off, the budget is a reference.
  if (body.budgetEnforced !== undefined) {
    if (typeof body.budgetEnforced !== 'boolean') throw badRequest('budgetEnforced tiene que ser true o false.')
    out.budgetEnforced = body.budgetEnforced
  }
  // null: every provider configured in the organization.
  if (body.allowedProviders !== undefined) {
    if (body.allowedProviders === null) {
      out.allowedProviders = null
    } else if (!Array.isArray(body.allowedProviders) || body.allowedProviders.length === 0 ||
               body.allowedProviders.some(p => !describe(p))) {
      // Empty is refused: gateways read an empty list as "all".
      throw badRequest('allowedProviders tiene que ser una lista de proveedores, o null para todos.')
    } else {
      out.allowedProviders = [...new Set(body.allowedProviders)]
    }
  }
  // null: no limit. Gateways lower requests that ask for more (from 0.3).
  out.maxTokensPerRequest = body.maxTokensPerRequest === null || body.maxTokensPerRequest === ''
    ? null : optionalNumber(body.maxTokensPerRequest, 'Máximo de tokens por pedido', { integer: true })
  if (out.maxTokensPerRequest === 0) throw badRequest('Máximo de tokens por pedido inválido: vacío para no limitar.')
  out.monthlyTokenQuota   = optionalNumber(body.monthlyTokenQuota, 'Cuota mensual de tokens', { integer: true })
  out.monthlyBudgetUsd    = optionalNumber(body.monthlyBudgetUsd, 'Presupuesto mensual')
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]  // null stays: it means "all"
  return out
}
