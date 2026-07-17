CREATE TABLE `e2e_platform_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`platform` text NOT NULL,
	`runner_id` text NOT NULL,
	`fencing_token` integer NOT NULL,
	`lease_expires_at` text NOT NULL,
	`last_seq_no` integer DEFAULT 0 NOT NULL,
	`cursor` text NOT NULL,
	`job_digest` text NOT NULL,
	`job_signature` text NOT NULL,
	`evidence_manifest_digest` text,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `e2e_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`runner_id`) REFERENCES `runner_registrations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `e2e_platform_fencing_unique` ON `e2e_platform_leases` (`attempt_id`,`platform`,`fencing_token`);--> statement-breakpoint
CREATE INDEX `e2e_platform_active_lease_idx` ON `e2e_platform_leases` (`attempt_id`,`platform`,`state`);--> statement-breakpoint
CREATE INDEX `e2e_platform_runner_lease_idx` ON `e2e_platform_leases` (`runner_id`,`state`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `platform_runner_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`platform_lease_id` text NOT NULL,
	`runner_id` text NOT NULL,
	`platform` text NOT NULL,
	`fencing_token` integer NOT NULL,
	`seq_no` integer NOT NULL,
	`commit_sha` text NOT NULL,
	`source_digest` text NOT NULL,
	`event_type` text NOT NULL,
	`status` text NOT NULL,
	`artifact_digest` text,
	`occurred_at` text NOT NULL,
	`received_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `e2e_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform_lease_id`) REFERENCES `e2e_platform_leases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`runner_id`) REFERENCES `runner_registrations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_runner_event_seq_unique` ON `platform_runner_events` (`platform_lease_id`,`seq_no`);--> statement-breakpoint
CREATE INDEX `platform_runner_event_attempt_idx` ON `platform_runner_events` (`attempt_id`,`platform`,`fencing_token`);--> statement-breakpoint
CREATE TABLE `runner_registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`spiffe_id` text NOT NULL,
	`certificate_fingerprint` text NOT NULL,
	`certificate_serial` text NOT NULL,
	`certificate_not_after` text NOT NULL,
	`platform` text NOT NULL,
	`architecture` text NOT NULL,
	`capability_digest` text NOT NULL,
	`capabilities` text NOT NULL,
	`state` text NOT NULL,
	`registered_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runner_spiffe_unique` ON `runner_registrations` (`spiffe_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runner_certificate_unique` ON `runner_registrations` (`certificate_fingerprint`);--> statement-breakpoint
CREATE INDEX `runner_platform_state_idx` ON `runner_registrations` (`platform`,`state`);