-- What each MCP server offers (ADR-0016, from 0.9): the gateways list its
-- tools (tools/list, never a call) and report them; the console keeps the
-- last report, for whoever administers the servers. The console never
-- calls the servers. Additive.
BEGIN;

ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS tools JSONB;            -- [{ name, description, read_only }]
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS tools_error TEXT;       -- why the last report has no tools
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS tools_at TIMESTAMPTZ;   -- when a gateway last reported it
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS tools_gateway TEXT;     -- which one

COMMIT;
