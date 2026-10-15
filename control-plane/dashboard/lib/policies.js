/**
 * lib/policies.js — validation of the policy fields the console edits.
 */

import { badRequest } from './route.js'

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
  out.maxTokensPerRequest = optionalNumber(body.maxTokensPerRequest, 'Máximo de tokens por request', { integer: true })
  out.monthlyTokenQuota   = optionalNumber(body.monthlyTokenQuota, 'Cuota mensual de tokens', { integer: true })
  out.monthlyBudgetUsd    = optionalNumber(body.monthlyBudgetUsd, 'Presupuesto mensual')
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out
}
