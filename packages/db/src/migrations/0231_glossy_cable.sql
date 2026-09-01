ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_external_custody_shape_check" CHECK ((
        "execution_workspaces"."custody_kind" = 'paperclip'
        AND "execution_workspaces"."external_connection_id" IS NULL
        AND "execution_workspaces"."external_lifecycle_id" IS NULL
        AND "execution_workspaces"."external_task_id" IS NULL
        AND "execution_workspaces"."prepared_identity_sha256" IS NULL
        AND "execution_workspaces"."authorized_start_head_sha" IS NULL
        AND "execution_workspaces"."repository_identity_sha256" IS NULL
        AND "execution_workspaces"."inspection_receipt_sha256" IS NULL
        AND "execution_workspaces"."external_root" IS NULL
        AND "execution_workspaces"."external_common_git_directory" IS NULL
      ) OR (
        "execution_workspaces"."custody_kind" = 'external_prepared'
        AND "execution_workspaces"."mode" = 'isolated_workspace'
        AND "execution_workspaces"."strategy_type" = 'git_worktree'
        AND "execution_workspaces"."provider_type" = 'git_worktree'
        AND "execution_workspaces"."project_workspace_id" IS NOT NULL
        AND "execution_workspaces"."external_connection_id" IS NOT NULL
        AND "execution_workspaces"."external_lifecycle_id" IS NOT NULL
        AND "execution_workspaces"."external_task_id" IS NOT NULL
        AND "execution_workspaces"."prepared_identity_sha256" ~ '^[0-9a-f]{64}$'
        AND "execution_workspaces"."authorized_start_head_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
        AND "execution_workspaces"."repository_identity_sha256" ~ '^[0-9a-f]{64}$'
        AND "execution_workspaces"."inspection_receipt_sha256" ~ '^[0-9a-f]{64}$'
        AND "execution_workspaces"."external_root" IS NOT NULL
        AND "execution_workspaces"."external_common_git_directory" IS NOT NULL
      ));