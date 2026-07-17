CREATE TABLE `github_candidate_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`spec_revision_id` text NOT NULL,
	`repository_binding_id` text NOT NULL,
	`artifact_digest` text NOT NULL,
	`base_commit_sha` text NOT NULL,
	`candidate_branch` text NOT NULL,
	`candidate_commit_sha` text NOT NULL,
	`source_digest` text NOT NULL,
	`pull_request_number` integer NOT NULL,
	`pull_request_node_id` text NOT NULL,
	`pull_request_url` text NOT NULL,
	`receipt` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`spec_revision_id`) REFERENCES `game_spec_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_binding_id`) REFERENCES `github_repository_bindings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_candidate_attempt_unique` ON `github_candidate_receipts` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `github_candidate_pr_unique` ON `github_candidate_receipts` (`repository_binding_id`,`pull_request_number`);--> statement-breakpoint
CREATE INDEX `github_candidate_project_commit_idx` ON `github_candidate_receipts` (`project_id`,`candidate_commit_sha`);--> statement-breakpoint
CREATE TABLE `github_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`account_node_id` text NOT NULL,
	`account_login` text NOT NULL,
	`repository_selection` text NOT NULL,
	`permissions` text NOT NULL,
	`status` text NOT NULL,
	`verified_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_installation_tenant_unique` ON `github_installations` (`tenant_id`,`installation_id`);--> statement-breakpoint
CREATE INDEX `github_installation_status_idx` ON `github_installations` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `github_merge_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`candidate_receipt_id` text NOT NULL,
	`acceptance_nonce` text NOT NULL,
	`evidence_bundle_digest` text NOT NULL,
	`candidate_commit_sha` text NOT NULL,
	`merge_commit_sha` text NOT NULL,
	`default_branch_head_sha` text NOT NULL,
	`requires_fresh_main_snapshot` integer NOT NULL,
	`receipt` text NOT NULL,
	`merged_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_receipt_id`) REFERENCES `github_candidate_receipts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_merge_candidate_unique` ON `github_merge_receipts` (`candidate_receipt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `github_merge_acceptance_nonce_unique` ON `github_merge_receipts` (`tenant_id`,`acceptance_nonce`);--> statement-breakpoint
CREATE INDEX `github_merge_project_commit_idx` ON `github_merge_receipts` (`project_id`,`merge_commit_sha`);--> statement-breakpoint
CREATE TABLE `github_repository_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`github_installation_id` text NOT NULL,
	`repository_id` integer NOT NULL,
	`repository_node_id` text NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text NOT NULL,
	`status` text NOT NULL,
	`bound_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`github_installation_id`) REFERENCES `github_installations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_repository_project_unique` ON `github_repository_bindings` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `github_repository_tenant_node_unique` ON `github_repository_bindings` (`tenant_id`,`repository_node_id`);--> statement-breakpoint
CREATE INDEX `github_repository_installation_idx` ON `github_repository_bindings` (`github_installation_id`,`status`);--> statement-breakpoint
CREATE TABLE `scm_operation_claims` (
	`key` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`operation` text NOT NULL,
	`request_digest` text NOT NULL,
	`claim_token` text NOT NULL,
	`claim_expires_at` text NOT NULL,
	`response` text,
	`authorized_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scm_operation_active_claim_idx` ON `scm_operation_claims` (`tenant_id`,`project_id`,`claim_expires_at`);