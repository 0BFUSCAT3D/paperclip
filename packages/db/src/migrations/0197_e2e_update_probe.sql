-- Test-only migration used by scripts/e2e-update-migrations.sh to prove that
-- `paperclipai update` applies pending migrations across versions.
-- This lives only on the test/e2e-update-next branch and is never merged.
CREATE TABLE IF NOT EXISTS "e2e_update_probe" (
	"id" serial PRIMARY KEY NOT NULL,
	"note" text DEFAULT 'applied-by-managed-update' NOT NULL
);
