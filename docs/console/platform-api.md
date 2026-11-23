# Platform API

Whoever runs an installation with many organizations (Stratum Cloud, or a
platform team serving several areas) manages them through the platform API:
list, create, suspend, delete and set the plan of organizations, and read
each one's usage per month for billing
([ADR-0020](../adr/0020-organizations-and-the-operator.md)).
`stratum-operator` (Enterprise) is a console on top of it; the same can be
done with `stratum-admin` or any HTTP client.

It never reaches inside an organization: not its people, policies,
credentials, requests or conversations. What it sees of each one is its
state, plan, limits and how many people, agents, teams and gateways it has.

## Tokens

A platform token belongs to no organization. Only the CLI makes one, with
a name and an expiry of at most a year; it is shown once and only its hash
is kept. An installation without platform tokens has no platform API.

```
node scripts/stratum-admin.mjs platform-token-create --name "stratum-operator" --days 90
node scripts/stratum-admin.mjs platform-token-list
node scripts/stratum-admin.mjs platform-token-revoke --id <uuid>
```

A platform token opens only `/api/platform`, and nothing else opens it: an
organization's sessions and service tokens get 401 there. The API is served
by the console, at the console's address. Where the console is public and
the platform's clients are not, block `/api/platform/` at the proxy in
front, as for `/api/internal/sync`.

```
Authorization: Bearer stplat_...
X-Stratum-Actor: ana@matech.lat     (optional)
```

What a token does is kept in the platform audit log as `platform:<name>`.
A client that acts for several people says who in `X-Stratum-Actor`, kept
next to it: `platform:stratum-operator (ana@matech.lat)`. The token is
what is trusted; the header only names.

## Routes

| Route | What it does |
|---|---|
| `GET /api/platform/organizations` | Every organization: `id`, `name`, `status`, `plan`, `limits`, `delete_after`, `created_at`, `counts` |
| `POST /api/platform/organizations` | `{ name, plan?, limits? }`: a new organization, without people. 409 if the name is taken (ignoring case) |
| `GET /api/platform/organizations/:id` | One organization, with `counts` for each limit |
| `PATCH /api/platform/organizations/:id` | `{ name?, plan?, limits? }`. Limits are merged: a number sets one, `null` removes it |
| `POST /api/platform/organizations/:id` | `{ action, reason, confirm? }`: `suspend`, `resume`, `delete` (with `confirm`, the name as written) or `undelete` |
| `GET /api/platform/usage?month=YYYY-MM` | Each organization's tokens, estimated cost and requests that month, and what it has now. `&format=csv` for a spreadsheet |
| `GET /api/platform/audit` | The platform audit log, newest first. `org_id`, `limit` (up to 500), `before=<id>` to page |

Limits are those of [Plan limits](access-control.md#plan-limits). A reason
(5 or more characters) is required to suspend, resume, delete and undelete,
and is kept in both audit logs. Errors are JSON with a stable `error` code
(`not_found`, `name_taken`, `bad_limits`, `reason_required`,
`confirm_mismatch`, `already_marked`, `not_marked`, `marked_for_deletion`)
and a `message` in English.

Every change is kept twice: in the platform audit log, which outlives the
organization, and in the organization's own audit log, so its Owner sees
what was done to it and when.

```sh
curl -s -H "Authorization: Bearer $STRATUM_PLATFORM_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"name":"Acme","plan":"Empresa","limits":{"people":25,"monthly_tokens":50000000}}' \
     https://consola.example.com/api/platform/organizations
```
