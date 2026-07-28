ALTER TABLE "issue_watchdogs" ADD COLUMN IF NOT EXISTS "mode" text NOT NULL DEFAULT 'subtask';
