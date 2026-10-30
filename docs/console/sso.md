# Signing in with the organization's identity provider (SSO)

People sign in to the console, and to the applications it signs people in
to (a chat portal, say), with their organization's account: Google
Workspace, or any OpenID Connect provider (Microsoft Entra ID, Okta,
Keycloak...). The console is an OpenID Connect client of that provider
(`lib/sso.js`, migration 034).

| | |
|---|---|
| Who gets in | Someone already in **Usuarios**, with that email, active. Nobody is created by signing in: add people first. |
| Which provider | The one whose domains include the email's domain (one provider per organization). A public email domain (gmail.com, outlook.com, yahoo.com...) is refused: anyone can have an address there. Only a console on localhost accepts one, to try SSO with a personal account. |
| What is checked | Authorization code with PKCE (S256), a nonce, and a state bound to the browser that started; the ID token's signature (the provider's JWKS, RS256 or ES256), issuer, audience, expiry and nonce; `email_verified`; the email's domain. With Google, a Workspace account of that domain (`hd`): a personal Google account with the same address does not get in. |
| Second factor | The provider's. A sign-in this way counts as one with two factors, for Owners and Admins and for applications that ask for them (`amr: ["fed"]`). Make the provider require it: in Google Workspace, enforce 2-Step Verification. |
| Console or applications | The console takes its roles (Owner, Admin, Team manager, Auditor); applications take anyone with access to applications, as with a password. |
| Password | Keeps working, unless **Exigir SSO** is on: then it no longer works for the provider's domains, in the console and in applications, except for Owners, who keep it (with their second factor) as the way in if the provider fails. |
| Audit | Every sign-in with SSO, and every refusal with its reason, is in **Auditoría**; so is every change to the provider. |

Turning it on needs `STRATUM_CONSOLE_URL` (`console.publicUrl` in the
chart): the provider sends people back to `{STRATUM_CONSOLE_URL}/api/sso/callback`.
The console needs a way out to the provider on port 443.

## Google Workspace

1. In Google Cloud, a project of your organization (any: it only holds the
   client). **Google Auth Platform** (or *APIs & Services → OAuth consent
   screen*): audience **Internal**, so only accounts of your Workspace can
   use it. No scopes beyond the basic ones (`openid`, `email`, `profile`).
2. **Clients → Create client**: type **Web application**, authorized
   redirect URI the one **Ingreso con SSO** shows
   (`https://stratum.acme.com/api/sso/callback`). Keep the client ID and
   the client secret.
3. In the console, as an Owner: **Ingreso con SSO** → Google Workspace, the
   client ID and secret, and your Workspace's email domains
   (`acme.com`, and any alias domain people use). Save: the console checks
   it can read Google's configuration.
4. From another browser, sign in with **Entrar con SSO** as someone who is
   in Usuarios. When it works for a few people, turn on **Exigir SSO** if
   you want the password gone for that domain.
5. In the Google Admin console: enforce 2-Step Verification for the
   organization.

Taking someone's access away: suspend them in Google (they can no longer
sign in) and, in Stratum, deactivate them or take their access to
applications away, which also stops their keys and their requests through
the gateways (`docs/console/access-control.md`).

## Other providers (OpenID Connect)

**Ingreso con SSO** → *Otro proveedor*: the issuer (its configuration must
be at `<issuer>/.well-known/openid-configuration`), a client of type web
application with the redirect URI above, scopes `openid email profile`, and
the email domains. The provider must give a verified `email` claim.

| Provider | Issuer |
|---|---|
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant id>/v2.0` (an app registration with a client secret; `email` as an optional claim, from a verified domain) |
| Okta | `https://<your domain>.okta.com` (or a custom authorization server's) |
| Keycloak | `https://<host>/realms/<realm>` |

## Not here (Stratum Enterprise)

SAML, creating people when they first sign in or from the directory (SCIM),
and teams from the provider's groups.

## API

`GET /api/sso` (Owner, Admin, Auditor), `PUT /api/sso`
`{ kind: "google" | "oidc", issuer?, clientId, clientSecret?, domains, enforce?, enabled? }`
and `DELETE /api/sso` (Owner). The client secret is stored encrypted with
`STRATUM_ENCRYPTION_KEY` and never shown again (only its last characters).
A domain belongs to one organization's provider.
