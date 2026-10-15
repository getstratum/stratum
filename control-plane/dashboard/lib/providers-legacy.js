import { json } from './route.js'

// The legacy providers table is shared by every organization and gateways do
// not read it, so the console no longer changes it.
export const LEGACY_PROVIDERS_GONE = () => json({
  error: 'gone',
  message: 'Los proveedores se configuran por organización en /api/internal/providers. Esta tabla ya no se edita.',
}, 410)
