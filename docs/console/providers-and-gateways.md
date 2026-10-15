# Providers and gateways in the console

## Providers

A provider configuration (`provider_configs`) is what gateways use to call an
LLM provider: the provider's name, an optional base URL and a credential.
Gateways receive it in the sync (at most 30 s later); clients choose it with
`"model": "<provider>/<model>"`, or just `"model": "<model>"` when the
organization has a single provider.

- **Presets** (`lib/providers.js`): Anthropic, OpenAI, Google Gemini, Mistral,
  Groq, DeepSeek, OpenRouter, xAI, Together AI, Azure OpenAI and Ollama. The
  name sets the protocol (Anthropic Messages, Azure OpenAI, or
  OpenAI-compatible) and, unless a base URL is given, the address. A preset's
  base URL must be https (a corporate proxy, for example).
- **Custom**: any OpenAI-compatible endpoint, named `custom-<name>`, with a
  base URL that may be an internal `http://` address. Gateways resolve it,
  not the control plane.
- One active configuration per provider name and organization (gateways
  address providers by name). Adding the same provider again replaces it.
- Credentials are encrypted with `STRATUM_ENCRYPTION_KEY` (AES-256-GCM) and
  never returned: the console shows their last four characters, who set them
  and when.
- **Connection test**: lists the provider's models with the credential, from
  the control plane, only for presets at their default address. The control
  plane never calls an address typed into the console, since it could point
  at the control plane's own network (cloud metadata, internal services).
  Configurations with their own address are tested from a gateway.
- Revoking a configuration removes it from gateways in the next sync.

Roles: Owner and Admin manage providers; Auditor reads them.

## Gateways

A gateway (data plane instance) is registered in the console and gets an
instance id and a sync token. Only the token's SHA-256 is stored: it is shown
once, on registration or rotation.

- **Status** comes from the gateway's own sync requests: *Sincronizado*
  (within 2 min), *Atrasado* (within 10 min), *Sin contacto*, *Nunca se
  conectó*, *Dado de baja*. The control plane never connects to the gateway.
- **Configuración** compares the version the gateway last fetched with the
  organization's current one.
- **Rotar token** replaces the token at once: the gateway keeps serving its
  last configuration until it is given the new one.
- **Dar de baja** disables the token for good.

Roles: Owner and Admin manage gateways; Auditor reads them.

## Upgrading

- **Agent keys start working** on gateways after migration 017: until then
  gateways refused every agent key, because the sync never sent them. Before
  upgrading, review the agents of each organization and revoke the keys
  nobody should be using.
- An agent's "default model" is for reference only: gateways do not enforce
  it yet. The team's policy decides which models the agent may use.
- Provider configurations saved before migration 018 show their credential
  as "configured" (no last-four preview) until it is replaced.
