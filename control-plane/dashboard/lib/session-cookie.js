// The console session cookie's name. Kept apart from lib/session.js so the
// proxy does not import node:crypto or the database.
export const COOKIE = 'stratum_session'
