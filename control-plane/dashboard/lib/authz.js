/**
 * lib/authz.js — the console's roles and what each one may do.
 *
 * One table, checked on the server by lib/route.js for every console API
 * route. The UI may hide what a role cannot do, but the table is what
 * decides.
 *
 * A permission maps each role that has it to a scope:
 *   'org'  — the whole organization of the session
 *   'team' — only the session user's own team
 *   'self' — only the session user
 * A role missing from a permission does not have it.
 */

export const ROLES = ['owner', 'admin', 'team_manager', 'auditor', 'member']

// Roles that can sign in to the console. Members only use API keys for now.
export const CONSOLE_ROLES = ['owner', 'admin', 'team_manager', 'auditor']

const ALL = { owner: 'org', admin: 'org', team_manager: 'team', auditor: 'org' }

export const PERMISSIONS = {
  // Organization
  'org.read':          { owner: 'org', admin: 'org', team_manager: 'org', auditor: 'org' },

  // People and agents
  'users.read':        ALL,
  'users.manage':      { owner: 'org', admin: 'org', team_manager: 'team' },
  'keys.manage':       { owner: 'org', admin: 'org', team_manager: 'team' },

  // Teams and policies
  'teams.read':        ALL,
  'teams.manage':      { owner: 'org', admin: 'org' },
  'teams.budget':      { owner: 'org', admin: 'org', team_manager: 'team' },
  'policies.read':     ALL,
  'policies.manage':   { owner: 'org', admin: 'org' },
  'alerts.read':       ALL,
  'alerts.manage':     { owner: 'org', admin: 'org', team_manager: 'team' },

  // Connections
  'providers.read':    { owner: 'org', admin: 'org', auditor: 'org' },
  'providers.manage':  { owner: 'org', admin: 'org' },
  'gateways.read':     { owner: 'org', admin: 'org', auditor: 'org' },
  'gateways.manage':   { owner: 'org', admin: 'org' },
  'models.read':       ALL,

  // Usage and records
  'usage.read':        ALL,
  'logs.read':         ALL,
  'audit.read':        { owner: 'org', admin: 'org', auditor: 'org' },
}

/** The scope `role` has for `permission`, or null. */
export function scopeFor(role, permission) {
  const p = PERMISSIONS[permission]
  if (!p) throw new Error(`unknown permission: ${permission}`)
  return p[role] ?? null
}

/**
 * Roles `actorRole` may give to someone (and may change someone holding).
 * Only an owner makes or unmakes owners; a team manager only manages members
 * of their team.
 */
export function assignableRoles(actorRole) {
  if (actorRole === 'owner') return ROLES
  if (actorRole === 'admin') return ['admin', 'team_manager', 'auditor', 'member']
  if (actorRole === 'team_manager') return ['member']
  return []
}
