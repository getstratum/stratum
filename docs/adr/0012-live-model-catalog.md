# ADR-0012: A model catalog that changes without a release

- **Status:** Accepted
- **Date:** 2026-10-18

## Context

The model catalog (`ai_models`) holds each model's IDs, aliases and list
prices. Policies name models from it, the sync expands every ID of a named
model (migration 023), and usage is costed with its prices. It only changed
through migrations, so every new model, alias or price waited for a
release, and an installation that did not upgrade costed usage with old
prices.

Organizations also need things the shared catalog cannot say: a model they
do not want anyone to use, even under a policy that allows all models; the
prices they negotiated; and models their provider offers that the catalog
does not list (most of the 75 catalog providers added in 0.2.0 have none).

## Decision

1. **A feed, read by the control plane once a day.** By default
   `catalog/models.json` in the Stratum repository, served from its main
   branch; it changes by pull request, reviewed like code. Schema 1: a date,
   and per model its provider, ID, name, aliases, list prices per million
   tokens, a retirement date and a retired flag.
   `STRATUM_MODEL_CATALOG_URL` points elsewhere (https) or turns it off;
   `stratum-admin catalog-update --file` applies a copy offline.
2. **A feed adds and updates, never deletes.** A model missing from the feed
   stays; `"retired": true` stops offering it. One malformed entry rejects
   the whole feed. A failure leaves the catalog as it was and is shown in
   the console. Several control plane replicas may read it at the same
   time: an advisory lock makes all but one skip.
3. **Version bumps as in migration 023**: new or changed IDs give the
   policies that name the model a new version; prices do not.
4. **Per organization** (`org_model_settings`): a model can be turned off
   and priced. Off models travel to gateways as `denied_models` in every
   policy of the organization, in their `provider/ID` forms with every
   alias, and gateways refuse them before the allowlist (`model_disabled`).
   Prices replace the list price when usage is costed.
5. **Models the provider lists** in a connection test are kept per
   organization (`provider_models`), so they can be chosen in policies,
   turned off or priced, even outside the catalog.

## Consequences

- New models and prices reach installations within a day, without an
  upgrade. Installations that cannot reach GitHub mirror the file or apply
  it by hand.
- The control plane makes one outgoing request a day to GitHub by default.
  It sends nothing about the installation; `off` turns it off.
- Trust: whoever can change the feed can change list prices and aliases,
  which affect costs and which IDs a policy's model covers. The default feed
  is changed only through reviewed pull requests on the Stratum repository;
  an installation that does not accept that points the variable at its own
  copy.
- Gateways older than 0.2 ignore `denied_models`: turning a model off needs
  updated gateways. Everything else is in the control plane.
- Prices in the feed are list prices for the shortest prompt-length tier;
  long-context, cached-input and batch prices are not modelled.
