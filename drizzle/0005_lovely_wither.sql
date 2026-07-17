CREATE TABLE `github_installation_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`state_digest` text NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`session_binding_digest` text NOT NULL,
	`stage` text NOT NULL,
	`installation_id` text,
	`pkce_verifier_secret_ref` text,
	`return_path` text NOT NULL,
	`status` text NOT NULL,
	`claim_token` text,
	`claim_expires_at` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`completed_at` text,
	`failure_code` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_authorization_state_unique` ON `github_installation_authorizations` (`state_digest`);--> statement-breakpoint
CREATE INDEX `github_authorization_principal_status_idx` ON `github_installation_authorizations` (`tenant_id`,`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `github_authorization_expiry_idx` ON `github_installation_authorizations` (`expires_at`,`status`);