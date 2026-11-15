-- 040_mcp_servers.sql
--
-- MCP servers (ADR-0016): the tools agents reach through the gateway at
-- /mcp/<name>, with the credential kept here, and which tools each policy
-- allows.
--
--   mcp_servers        per organization: name, address, the header the
--                      gateway sends and its value, encrypted (lib/secrets.js)
--   policies.mcp_tools "server/*" or "server/tool": what the policy's teams
--                      may call; empty, nothing (a new surface is closed
--                      until someone opens it)
--
-- Gateways get the servers with every sync, the whole list (not versioned),
-- like routes; a change to mcp_tools gives the policy a new version.

BEGIN;

CREATE TABLE IF NOT EXISTS mcp_servers (
  id               TEXT PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             VARCHAR(50) NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,49}$'),
  description      TEXT NOT NULL DEFAULT '',
  url              TEXT NOT NULL,
  auth_header      TEXT,
  secret_encrypted TEXT,
  secret_hint      TEXT,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  updated_by       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

ALTER TABLE policies ADD COLUMN IF NOT EXISTS mcp_tools TEXT[] NOT NULL DEFAULT '{}';

COMMIT;
