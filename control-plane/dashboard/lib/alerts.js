/**
 * lib/alerts.js — validation of alert fields.
 */

import { badRequest } from './route.js'
import { webhookProblem } from './alert-delivery.js'

// default_model: when the team's default model stops working as set
// (lib/default-model-notices.js); model_retiring: when a model the team
// uses retires (lib/retiring-models.js). Their threshold is not used.
const TYPES = new Set(['budget', 'quota', 'policy_violation', 'default_model', 'model_retiring'])
const CHANNELS = new Set(['email', 'slack'])
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/

export function alertFields(body, { create = false } = {}) {
  const out = {}
  if (create || body.alertType !== undefined) {
    if (!TYPES.has(body.alertType)) throw badRequest('Tipo de alerta inválido.')
    out.alertType = body.alertType
  }
  if (create || body.channel !== undefined) {
    if (!CHANNELS.has(body.channel)) throw badRequest('Canal inválido.')
    out.channel = body.channel
  }
  if (create || body.destination !== undefined) {
    const d = body.destination
    if (typeof d !== 'string' || !d.trim() || d.length > 500) throw badRequest('Destino inválido.')
    out.destination = d.trim()
  }
  if (body.thresholdPct !== undefined) {
    const n = Number(body.thresholdPct)
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw badRequest('Umbral inválido.')
    out.thresholdPct = n
  }
  return out
}

/**
 * Checks the destination against the channel, once both are known (a PATCH
 * may change only one of them). Webhooks go only to the hosts the operator
 * allows (lib/alert-delivery.js).
 */
export function checkDestination(channel, destination) {
  if (channel === 'email' && !EMAIL_RE.test(destination)) throw badRequest('La dirección de email no es válida.')
  if (channel === 'slack') {
    const problem = webhookProblem(destination)
    if (problem) throw badRequest(`El webhook ${problem}.`)
  }
}
