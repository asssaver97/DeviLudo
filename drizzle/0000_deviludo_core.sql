CREATE TABLE `agent_defaults` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`profile_revision_id` text NOT NULL,
	`policy` text NOT NULL,
	`explicitly_allowed_fallbacks` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_revision_id`) REFERENCES `agent_profile_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_default_scope_unique` ON `agent_defaults` (`scope`,`scope_id`);--> statement-breakpoint
CREATE TABLE `agent_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`registry_id` text NOT NULL,
	`agent_version_id` text NOT NULL,
	`worker_image_id` text NOT NULL,
	`image_digest` text NOT NULL,
	`worker_pool` text NOT NULL,
	`rollout_percent` integer DEFAULT 0 NOT NULL,
	`rollback_installation_id` text,
	`health` text DEFAULT 'UNKNOWN' NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`registry_id`) REFERENCES `agent_registries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_version_id`) REFERENCES `agent_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_image_id`) REFERENCES `worker_images`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `installation_pool_state_idx` ON `agent_installations` (`worker_pool`,`state`);--> statement-breakpoint
CREATE TABLE `agent_profile_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`revision` integer NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`agent_kind` text NOT NULL,
	`installation_id` text NOT NULL,
	`provider_revision_id` text NOT NULL,
	`model_roles` text NOT NULL,
	`credential_binding_id` text NOT NULL,
	`credential_version_id` text NOT NULL,
	`permissions` text NOT NULL,
	`budget` text NOT NULL,
	`fallback_profile_revision_id` text,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `agent_installations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_revision_id`) REFERENCES `provider_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_version_id`) REFERENCES `credential_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_revision_unique` ON `agent_profile_revisions` (`profile_id`,`revision`);--> statement-breakpoint
CREATE INDEX `profile_scope_state_idx` ON `agent_profile_revisions` (`scope`,`scope_id`,`state`);--> statement-breakpoint
CREATE TABLE `agent_registries` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`vendor` text NOT NULL,
	`display_name` text NOT NULL,
	`official_source` text NOT NULL,
	`adapter_id` text NOT NULL,
	`configuration_schema_version` text NOT NULL,
	`capabilities` text NOT NULL,
	`supported_worker_platforms` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_registries_kind_unique` ON `agent_registries` (`kind`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`iteration_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`profile_revision_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`image_digest` text NOT NULL,
	`exact_agent_version` text NOT NULL,
	`adapter_version` text NOT NULL,
	`provider_revision_id` text NOT NULL,
	`model` text NOT NULL,
	`credential_version_id` text NOT NULL,
	`configuration_lock` text NOT NULL,
	`resolution_digest` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`iteration_id`) REFERENCES `game_iterations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`profile_revision_id`) REFERENCES `agent_profile_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`installation_id`) REFERENCES `agent_installations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_revision_id`) REFERENCES `provider_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_version_id`) REFERENCES `credential_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_idempotency_unique` ON `agent_runs` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `agent_run_project_state_idx` ON `agent_runs` (`tenant_id`,`project_id`,`state`);--> statement-breakpoint
CREATE TABLE `agent_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`registry_id` text NOT NULL,
	`exact_version` text NOT NULL,
	`source_url` text NOT NULL,
	`package_integrity` text NOT NULL,
	`sha256` text NOT NULL,
	`signature_verified` integer DEFAULT false NOT NULL,
	`sbom_digest` text,
	`vulnerability_report_digest` text,
	`adapter_min_version` text NOT NULL,
	`adapter_max_exclusive_version` text NOT NULL,
	`release_notes_url` text NOT NULL,
	`state` text NOT NULL,
	`discovered_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`registry_id`) REFERENCES `agent_registries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_exact_version_unique` ON `agent_versions` (`registry_id`,`exact_version`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`project_id` text,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`request_id` text NOT NULL,
	`idempotency_key` text,
	`before_digest` text,
	`after_digest` text,
	`metadata` text NOT NULL,
	`previous_event_hash` text,
	`event_hash` text NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_event_hash_unique` ON `audit_events` (`event_hash`);--> statement-breakpoint
CREATE INDEX `audit_tenant_time_idx` ON `audit_events` (`tenant_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `credential_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`binding_id` text NOT NULL,
	`tenant_id` text,
	`project_id` text,
	`secret_ref` text NOT NULL,
	`fingerprint` text NOT NULL,
	`masked_value` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`rotated_at` text,
	`revoked_at` text,
	`last_used_at` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credential_binding_fingerprint_unique` ON `credential_versions` (`binding_id`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `e2e_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`iteration_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`runner_id` text,
	`fencing_token` integer NOT NULL,
	`last_seq_no` integer DEFAULT 0 NOT NULL,
	`commit_sha` text NOT NULL,
	`source_digest` text NOT NULL,
	`spec_revision_id` text NOT NULL,
	`spec_digest` text NOT NULL,
	`test_plan_digest` text NOT NULL,
	`target_matrix` text NOT NULL,
	`lease_expires_at` text,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`iteration_id`) REFERENCES `game_iterations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`spec_revision_id`) REFERENCES `game_spec_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `e2e_run_attempt_unique` ON `e2e_attempts` (`run_id`,`attempt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `e2e_fencing_unique` ON `e2e_attempts` (`id`,`fencing_token`);--> statement-breakpoint
CREATE INDEX `e2e_lease_idx` ON `e2e_attempts` (`state`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `evidence_bundles` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`spec_revision_id` text NOT NULL,
	`spec_digest` text NOT NULL,
	`test_plan_digest` text NOT NULL,
	`commit_sha` text NOT NULL,
	`source_digest` text NOT NULL,
	`target_matrix` text NOT NULL,
	`manifest` text NOT NULL,
	`bundle_digest` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `e2e_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`spec_revision_id`) REFERENCES `game_spec_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_bundles_bundle_digest_unique` ON `evidence_bundles` (`bundle_digest`);--> statement-breakpoint
CREATE INDEX `evidence_project_commit_idx` ON `evidence_bundles` (`project_id`,`commit_sha`);--> statement-breakpoint
CREATE TABLE `evidence_invalidations` (
	`id` text PRIMARY KEY NOT NULL,
	`evidence_bundle_id` text NOT NULL,
	`iteration_id` text NOT NULL,
	`reason` text NOT NULL,
	`invalidated_by` text NOT NULL,
	`invalidated_at` text NOT NULL,
	FOREIGN KEY (`evidence_bundle_id`) REFERENCES `evidence_bundles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`iteration_id`) REFERENCES `game_iterations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `game_iterations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`iteration_number` integer NOT NULL,
	`previous_iteration_id` text,
	`spec_revision_id` text NOT NULL,
	`spec_digest` text NOT NULL,
	`candidate_branch` text NOT NULL,
	`candidate_commit_sha` text NOT NULL,
	`draft_pull_request_url` text NOT NULL,
	`feedback` text,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`spec_revision_id`) REFERENCES `game_spec_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `iteration_project_number_unique` ON `game_iterations` (`project_id`,`iteration_number`);--> statement-breakpoint
CREATE INDEX `iteration_tenant_project_idx` ON `game_iterations` (`tenant_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `game_spec_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`revision` integer NOT NULL,
	`previous_revision_id` text,
	`state` text NOT NULL,
	`content` text NOT NULL,
	`content_digest` text NOT NULL,
	`test_plan_digest` text NOT NULL,
	`target_matrix` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`approved_by` text,
	`approved_at` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spec_project_revision_unique` ON `game_spec_revisions` (`project_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `spec_project_digest_unique` ON `game_spec_revisions` (`project_id`,`content_digest`);--> statement-breakpoint
CREATE INDEX `spec_tenant_project_idx` ON `game_spec_revisions` (`tenant_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `idempotency_records` (
	`tenant_id` text NOT NULL,
	`key` text NOT NULL,
	`request_digest` text NOT NULL,
	`response_status` integer NOT NULL,
	`response_body` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_tenant_key_unique` ON `idempotency_records` (`tenant_id`,`key`);--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text,
	`topic` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	`published_at` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `outbox_unpublished_idx` ON `outbox_events` (`published_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`github_installation_id` text,
	`github_repository_node_id` text,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`steam_app_id` text,
	`created_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_tenant_slug_unique` ON `projects` (`tenant_id`,`slug`);--> statement-breakpoint
CREATE INDEX `project_tenant_idx` ON `projects` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `provider_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`revision` integer NOT NULL,
	`tenant_id` text,
	`project_id` text,
	`agent_kind` text NOT NULL,
	`protocol` text NOT NULL,
	`base_url` text NOT NULL,
	`model_roles` text NOT NULL,
	`credential_binding_id` text NOT NULL,
	`credential_version_id` text NOT NULL,
	`compliance` text NOT NULL,
	`security_approval_id` text,
	`probe_evidence_digest` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_revision_unique` ON `provider_revisions` (`provider_id`,`revision`);--> statement-breakpoint
CREATE TABLE `runner_events` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`fencing_token` integer NOT NULL,
	`seq_no` integer NOT NULL,
	`commit_sha` text NOT NULL,
	`source_digest` text NOT NULL,
	`platform` text NOT NULL,
	`event_type` text NOT NULL,
	`status` text NOT NULL,
	`artifact_digest` text,
	`occurred_at` text NOT NULL,
	`received_at` text NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `e2e_attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runner_event_seq_unique` ON `runner_events` (`attempt_id`,`fencing_token`,`seq_no`);--> statement-breakpoint
CREATE TABLE `steam_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`main_commit_sha` text NOT NULL,
	`source_digest` text NOT NULL,
	`evidence_bundle_id` text NOT NULL,
	`target_matrix` text NOT NULL,
	`steam_app_id` text NOT NULL,
	`steam_session_secret_ref` text NOT NULL,
	`beta_branch` text NOT NULL,
	`mfa_approval_id` text NOT NULL,
	`state` text NOT NULL,
	`external_gate` text DEFAULT 'NONE' NOT NULL,
	`created_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evidence_bundle_id`) REFERENCES `evidence_bundles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `steam_release_project_state_idx` ON `steam_releases` (`project_id`,`state`);--> statement-breakpoint
CREATE TABLE `tenant_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_membership_unique` ON `tenant_memberships` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`created_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_slug_unique` ON `tenants` (`slug`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`github_subject` text NOT NULL,
	`display_name` text NOT NULL,
	`avatar_url` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_subject_unique` ON `users` (`github_subject`);--> statement-breakpoint
CREATE TABLE `worker_images` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_version_id` text NOT NULL,
	`exact_agent_version` text NOT NULL,
	`adapter_version` text NOT NULL,
	`base_image_digest` text NOT NULL,
	`image_digest` text NOT NULL,
	`sbom_digest` text NOT NULL,
	`scan_digest` text NOT NULL,
	`built_at` text NOT NULL,
	FOREIGN KEY (`agent_version_id`) REFERENCES `agent_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_images_image_digest_unique` ON `worker_images` (`image_digest`);