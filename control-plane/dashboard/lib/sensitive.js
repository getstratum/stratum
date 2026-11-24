/**
 * lib/sensitive.js — the names the console gives to what a policy's PII and
 * DLP look for (the gateway's detectors) and to what it does with them
 * (lib/policies.js, CONTENT_ACTIONS).
 */

export const DATA_TYPES = {
  email: 'email', phone: 'teléfono', credit_card: 'tarjeta', ssn: 'SSN',
  ci_uy: 'cédula', ip_address: 'dirección IP', api_key: 'clave o token',
}

export const typeLabel = (t) => DATA_TYPES[t] ?? t

// What a policy does with them (migration 013): pii_action and dlp_action.
export const CONTENT_ACTIONS = ['off', 'log', 'redact', 'block']

export const ACTION_LABELS = {
  off:    'No revisar',
  log:    'Solo registrar',
  redact: 'Ocultar antes de enviar',
  block:  'Bloquear el pedido',
}
