# Applications: signing in with the console account

The console is an OpenID Connect provider for the organization's own
applications, such as a chat portal or an internal tool. People sign in to
them with their Stratum account (password, and the second factor when the
application asks for it), and the application gets an ID token with who they
are, their organization and their team.

It is meant for applications that call the gateway on behalf of people
(`X-Stratum-User`, see the README): the ID token's `sub` is the id the
gateway's people directory knows.

## Turning it on

Set `STRATUM_CONSOLE_URL` (`console.publicUrl` in the chart) to the console's
public address, with https (http only on localhost, for development). It is
the issuer; discovery is at `{STRATUM_CONSOLE_URL}/.well-known/openid-configuration`.
Without it the endpoints answer 404 and **Aplicaciones** says how to turn it on.

## Registering an application

**Aplicaciones → Nueva aplicación** (Owner or Admin): a name, the exact
redirect URIs (https, or http on localhost), and whether it asks for a second
factor (on by default). The answer shows the `client_id` and the
`client_secret` once; the console keeps only a hash of the secret. **Nuevo
secreto** replaces it at once; **Dar de baja** stops new sign-ins and voids
codes not yet redeemed.

## What applications get

| | |
|---|---|
| Flow | Authorization code with PKCE (`S256`, required). No implicit flow, no refresh tokens. |
| Client authentication | `client_secret_basic` or `client_secret_post`. |
| ID token | RS256, 5 minutes. `iss`, `sub` (the person's id), `aud` (the client_id), `iat`, `exp`, `auth_time`, `nonce`, `amr` (`pwd`, plus `otp` with a second factor), `org_id`, `team_id`; `email` with scope `email`, `name` with scope `profile`. |
| Access token | A JWT for `userinfo` only, 5 minutes. |
| Keys | `/api/oidc/jwks`. Made on first use, the private key encrypted with `STRATUM_ENCRYPTION_KEY`. If that key changes, the signing key is replaced on the next sign-in. |

Applications keep their own session after the sign-in. The console keeps
none for them: every sign-in asks for the password again.

## Who may sign in

An active person of the application's organization, with a password, a team
and access to applications (People → Quitar aplicaciones takes it away).
Their console role does not matter: Members, who cannot use the console, sign
in to applications. Anyone else gets the same refusal as a wrong password,
and the reason goes to the audit log (`app.login`).

When the application asks for a second factor and the person has none, they
set it up during the sign-in (QR code, first code, recovery codes) and it
stays on their account. Failed attempts count against the same lockout as
the console's sign-in.

Userinfo refuses a token as soon as the person loses access; an ID token
already issued stays valid for its 5 minutes, so applications should check
it right after the sign-in, not hold on to it.
