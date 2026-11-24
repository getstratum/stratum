-- ============================================================
--  Migration 051 — an application in the console's menu
-- ============================================================
--
-- oidc_clients.console_link: the console's menu links to the application
-- (at the address of its first redirect URI), for everyone who signs in to
-- the console. An Owner or Admin turns it on in Aplicaciones, for an
-- application people of the console use: Stratum Enterprise, say. The
-- console knows nothing of what the application does: a name and a link.
--
-- Additive.

BEGIN;

ALTER TABLE oidc_clients ADD COLUMN IF NOT EXISTS console_link BOOLEAN NOT NULL DEFAULT false;

COMMIT;
