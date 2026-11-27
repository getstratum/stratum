/**
 * The permissions a service token can carry (lib/service-tokens.js), apart
 * so scripts/stratum-admin.mjs reads them without the route helpers.
 */
export const SCOPES = [
  'users.read', 'users.manage', 'keys.manage',
  'teams.read', 'teams.manage', 'teams.budget',
  'policies.read', 'policies.manage',
  'alerts.read', 'alerts.manage',
  'models.read', 'models.manage',
  'providers.read', 'gateways.read', 'apps.read', 'sso.read',
  'usage.read', 'logs.read', 'audit.read',
]
