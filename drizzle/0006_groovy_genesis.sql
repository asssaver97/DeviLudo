CREATE TABLE `steam_build_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`release_id` text NOT NULL,
	`steam_app_id` text NOT NULL,
	`build_id` text NOT NULL,
	`main_commit_sha` text NOT NULL,
	`source_digest` text NOT NULL,
	`evidence_bundle_digest` text NOT NULL,
	`beta_branch` text NOT NULL,
	`depot_manifest_ids` text NOT NULL,
	`install_attempts` text NOT NULL,
	`steam_install_evidence_bundle_digest` text,
	`state` text NOT NULL,
	`uploaded_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`release_id`) REFERENCES `steam_releases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `steam_build_receipt_release_unique` ON `steam_build_receipts` (`release_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `steam_build_receipt_app_build_unique` ON `steam_build_receipts` (`steam_app_id`,`build_id`);--> statement-breakpoint
CREATE INDEX `steam_build_receipt_project_state_idx` ON `steam_build_receipts` (`project_id`,`state`);--> statement-breakpoint
CREATE TABLE `steam_build_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`account_id` text NOT NULL,
	`account_name` text NOT NULL,
	`config_vdf_secret_ref` text NOT NULL,
	`credential_version_id` text NOT NULL,
	`allowed_app_ids` text NOT NULL,
	`permissions` text NOT NULL,
	`state` text NOT NULL,
	`verified_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_version_id`) REFERENCES `credential_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `steam_build_session_account_version_unique` ON `steam_build_sessions` (`tenant_id`,`account_id`,`credential_version_id`);--> statement-breakpoint
CREATE INDEX `steam_build_session_state_idx` ON `steam_build_sessions` (`tenant_id`,`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `steam_publish_claims` (
	`key` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`release_id` text NOT NULL,
	`request_digest` text NOT NULL,
	`claim_token` text NOT NULL,
	`claim_expires_at` text NOT NULL,
	`response` text,
	`authorized_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`release_id`) REFERENCES `steam_releases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `steam_publish_active_claim_idx` ON `steam_publish_claims` (`tenant_id`,`project_id`,`claim_expires_at`);
--> statement-breakpoint
CREATE TRIGGER steam_build_receipt_binding_immutable BEFORE UPDATE ON steam_build_receipts
WHEN NEW.tenant_id <> OLD.tenant_id
  OR NEW.project_id <> OLD.project_id
  OR NEW.release_id <> OLD.release_id
  OR NEW.steam_app_id <> OLD.steam_app_id
  OR NEW.build_id <> OLD.build_id
  OR NEW.main_commit_sha <> OLD.main_commit_sha
  OR NEW.source_digest <> OLD.source_digest
  OR NEW.evidence_bundle_digest <> OLD.evidence_bundle_digest
  OR NEW.beta_branch <> OLD.beta_branch
  OR NEW.depot_manifest_ids <> OLD.depot_manifest_ids
  OR NEW.install_attempts <> OLD.install_attempts
  OR NEW.uploaded_at <> OLD.uploaded_at
  OR NEW.created_at <> OLD.created_at
  OR NOT (OLD.state = 'INSTALL_TESTING'
    AND NEW.state = 'EXTERNAL_APPROVAL_REQUIRED'
    AND OLD.steam_install_evidence_bundle_digest IS NULL
    AND NEW.steam_install_evidence_bundle_digest NOT GLOB '*[^0-9a-f]*'
    AND length(NEW.steam_install_evidence_bundle_digest) = 64)
BEGIN
  SELECT RAISE(ABORT, 'steam build receipt binding is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER steam_build_receipt_no_delete BEFORE DELETE ON steam_build_receipts
BEGIN
  SELECT RAISE(ABORT, 'steam build receipts are append-only');
END;
