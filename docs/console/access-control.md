# Console access control

How people sign in to the control plane console, what each role may do, and
how that is enforced. Migration `016_console_authz.sql` and
`control-plane/dashboard/lib/{authz,session,route,audit}.js`.

## Accounts and sign-in

- People sign in with **email and password**. API keys are for gateways only:
  they no longer open the console.
- Passwords: at least 12 characters, stored with scrypt
  (`scrypt$N$r$p$salt$hash`, N = 2^15). Hashes from before migration 016 are
  still accepted and rewritten on the next sign-in.
- After 10 failed attempts in a row the account is locked for 15 minutes.
  Attempts are counted before the password is checked, so a burst of parallel
  requests gets no more than 10 tries either.
- Every refusal is the same 401: the answer never says whether an email has an
  account, or whether it is locked, deactivated or without console access.
  The reason is in the audit log.
- People change their own password in "Mi cuenta"
  (`POST /api/session/password`), giving the current one; their other
  sessions end. Nobody changes their own password through the user
  management routes.
- The console has no default account. The first Owner is created from the
  command line, inside the control plane container:

  ```sh
  node scripts/stratum-admin.mjs create-owner --email you@example.com          # the only organization
  node scripts/stratum-admin.mjs create-owner --email you@example.com --org-name "Acme"
  node scripts/stratum-admin.mjs create-owner --email you@example.com --org-id <uuid>
  node scripts/stratum-admin.mjs reset-password --email you@example.com
  ```

  Each prints a random password once; `--password-stdin` takes one instead.
  The same command is the way back in when nobody can sign in.

## Sessions

- Kept in `console_sessions`. The cookie (`stratum_session`, HttpOnly,
  SameSite=Lax, Secure) holds 32 random bytes; the database holds their
  SHA-256.
- A session ends after **30 minutes without use** or **12 hours** after
  sign-in (`STRATUM_SESSION_IDLE_MINUTES`, `STRATUM_SESSION_MAX_HOURS`), at
  sign-out, and **at once** when the person is deactivated, their role, team
  or password changes, or their organization is suspended.
- The client address in the audit log is the entry
  `STRATUM_TRUSTED_PROXY_HOPS` places from the right of `X-Forwarded-For`
  (default 1, one reverse proxy; 2 behind Google Cloud's load balancer).
- `SECURE_COOKIES=false` drops the Secure flag, for plain HTTP from a host
  other than `localhost` on a network you trust. `SESSION_SECRET` is no longer
  used.

## Roles

Five fixed roles per organization. The table lives in `lib/authz.js`; this is
a summary.

| | Owner | Admin | Team manager | Auditor | Member |
|---|---|---|---|---|---|
| Sign in to the console | yes | yes | yes | yes | no (API key only) |
| People and agents | all | all but owners | own team, members only | read | — |
| API keys (rotate, revoke) | all | all but owners' | own team | — | — |
| Teams: name and policy | yes | yes | — | read | — |
| Teams: budget | yes | yes | own team | read | — |
| Policies | yes | yes | read own team's | read | — |
| Providers, gateways | yes | yes | — | read | — |
| Usage and request logs | all | all | own team | all | — |
| Audit log | yes | yes | — | yes | — |

Also:

- Only an Owner makes or unmakes Owners. Nobody changes their own role or
  deactivates themselves, and an organization always keeps one active Owner
  (changes to people are serialized per organization, so two owners demoting
  each other at once cannot leave none).
- A team manager always has a team; one without a team (left over from an
  earlier change) is refused everything that is scoped to a team.
- Team managers do not set passwords: their members have no console access,
  and a password they knew would still work if the member were promoted.
- Emails are unique across the whole installation (a person belongs to one
  organization), so creating an account with an email used in another
  organization fails.
- Provider credentials are never returned by any route, to any role.

## Enforcement

- Every console API route is built with `route(permission, handler)`
  (`lib/route.js`). It refuses state-changing requests from another site,
  loads the session (401 without one), checks the role's permission (403,
  recorded in the audit log) and hands the handler the session with its scope:
  `org`, or `team` for a team manager.
- Every query filters by the session's organization. Objects of another
  organization answer 404, as if they did not exist, and references to them
  (a team or policy id in a request body) are refused the same way.
- `test/routes.test.mjs` fails if a route file exports a handler that does not
  go through `route()`, `publicRoute()` (health check, sign-in, sign-out) or
  `tokenRoute()` (the gateways' sync and metrics, authenticated by sync token).
- `test/authz.test.mjs` checks the rules above against PostgreSQL, with two
  organizations.

## Audit log

`audit_log` records sign-ins (failed ones too), every change made through the
console, and every request refused by a permission check, with who, when, from
which address and on what. It never holds passwords, keys or credentials.
Rows cannot be updated or deleted (a trigger refuses it); retention is done by
an operator with `TRUNCATE` or partition drops. `GET /api/audit` reads an
organization's log (Owner, Admin, Auditor).

## Upgrading from a version before migration 016

- Roles are renamed: `org_admin` → `owner`, `user` → `member`; `admin` stays.
  Console access used to be "any user in a team called Engineering"; that rule
  is gone. Create an Owner with `stratum-admin create-owner` and assign roles
  from the console.
- The demo seed's API keys (`aig_sk_eng_test1234567890`,
  `aig_sk_mkt_test1234567890`) and placeholder passwords are removed; gateways
  receive the revocation in their next sync.
- The Playground (`/prompt`) is removed: it called gateway routes that no
  longer exist.
- The legacy `providers` table (global, not read by gateways) is no longer
  used by the console; provider credentials are managed per organization in
  Providers (`/api/internal/providers`).
