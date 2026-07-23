CREATE TABLE `local_project_commands` (
	`command_key` text PRIMARY KEY NOT NULL,
	`request_digest` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `local_projects` (
	`project_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`repository_binding_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`repository_id` integer NOT NULL,
	`repository_node_id` text NOT NULL,
	`owner` text NOT NULL,
	`repository_name` text NOT NULL,
	`default_branch` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_projects_slug_unique` ON `local_projects` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `local_projects_repository_binding_id_unique` ON `local_projects` (`repository_binding_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `local_projects_repository_node_id_unique` ON `local_projects` (`repository_node_id`);
--> statement-breakpoint
CREATE TRIGGER local_projects_limit
BEFORE INSERT ON local_projects WHEN (SELECT COUNT(*) FROM local_projects) >= 100
BEGIN SELECT RAISE(ABORT, 'local project limit reached'); END;
