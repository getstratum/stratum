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
- **Último uso reportado** is when the gateway last sent its usage records
  (ADR-0009). A gateway that syncs but has not reported usage for a while
  is either idle or cannot reach `/api/internal/usage`: check its
  `stratum_usage_records_buffered` and `stratum_usage_push_failures_total`.
- **Rotar token** replaces the token at once: the gateway keeps serving its
  last configuration until it is given the new one.
- **Dar de baja** disables the token for good.

Roles: Owner and Admin manage gateways; Auditor reads them.

## Agents: fixed model

An agent's **Fixed model** (Agents → Edit) is sent to the gateways with its
key (migration 021) and applied to every request of that key: the gateways
send it to that provider and model whatever model it asks for, so an
administrator can move all of an agent's traffic to another model from the
console. It still has to be allowed by the team's policy, and a request in
the other API format is refused (`agent_model_mismatch`). Empty: the agent
chooses, within the policy. A change reaches the gateways in the next sync.

Azure OpenAI runs the deployment named in the URL
(`/proxy/azure/deployments/<name>/...`), not the model in the body. So for
Azure the gateways treat that name as the model: the policy checks it, and
an agent's fixed model replaces it in the URL.

## Upgrading

- **Agent keys start working** on gateways after migration 017: until then
  gateways refused every agent key, because the sync never sent them. Before
  upgrading, review the agents of each organization and revoke the keys
  nobody should be using.
- From migration 021 an agent's model, if set, is enforced by the gateways
  (see "Agents: fixed model"). Agents that had one set for reference start
  using it on upgrade: review them first.
- Provider configurations saved before migration 018 show their credential
  as "configured" (no last-four preview) until it is replaced.
