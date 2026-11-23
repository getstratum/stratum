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
| `POST /api/platform/organizations/:id/invitations` | `{ email }`: invites its first Owner (see below). Again for the same email replaces the open one |
| `GET /api/platform/organizations/:id/invitations` | The open invitations made from outside the organization, to see whether the Owner came in |
| `GET /api/platform/organizations/:id` | One organization, with `counts` for each limit |
| `PATCH /api/platform/organizations/:id` | `{ name?, plan?, limits? }`. Limits are merged: a number sets one, `null` removes it |
| `POST /api/platform/organizations/:id` | `{ action, reason, confirm? }`: `suspend`, `resume`, `delete` (with `confirm`, the name as written) or `undelete` |
| `GET /api/platform/usage?month=YYYY-MM` | Each organization's tokens, estimated cost and requests that month, and what it has now. `&format=csv` for a spreadsheet |
| `GET /api/platform/audit` | The platform audit log, newest first. `org_id`, `limit` (up to 500), `before=<id>` to page |

Limits are those of [Plan limits](access-control.md#plan-limits). A reason
(5 or more characters) is required to suspend, resume, delete and undelete,
and is kept in both audit logs. Errors are JSON with a stable `error` code
(`not_found`, `name_taken`, `bad_limits`, `reason_required`,
`confirm_mismatch`, `already_marked`, `not_marked`, `marked_for_deletion`,
`bad_email`, `email_taken`, `org_unavailable`)
and a `message` in English.

## The first Owner

A new organization has no people. Its first Owner comes by invitation: a
link that works once, for 72 hours, where they choose their password and
then set up their second factor. Nobody else knows that password.

When the console sends email (`STRATUM_SMTP_URL`), the link goes to the
Owner and is not in the answer: whoever runs the installation never holds
it. Without SMTP, or if sending failed, the answer carries `link` and
`reason`, to pass it on another way; whoever has the link can use it, so
treat it like a password until it is used. Links point to
`STRATUM_CONSOLE_URL`, or to the address the request came to when it is
not set. The token goes after `#`, which browsers never send, so it is in
no access log.

`stratum-admin org-invite --org-id <uuid> --email <email>` does the same
from the CLI (it needs `STRATUM_CONSOLE_URL`).

Every change is kept twice: in the platform audit log, which outlives the
organization, and in the organization's own audit log, so its Owner sees
what was done to it and when.

```sh
curl -s -H "Authorization: Bearer $STRATUM_PLATFORM_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"name":"Acme","plan":"Empresa","limits":{"people":25,"monthly_tokens":50000000}}' \
     https://consola.example.com/api/platform/organizations
```
