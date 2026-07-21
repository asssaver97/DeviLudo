CREATE TABLE `local_admin_state_revisions` (
	`revision` integer PRIMARY KEY NOT NULL,
	`schema_version` text NOT NULL,
	`command_key` text,
	`state_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_admin_state_revisions_command_key_unique` ON `local_admin_state_revisions` (`command_key`);
--> statement-breakpoint
CREATE TRIGGER local_admin_state_no_update
BEFORE UPDATE ON local_admin_state_revisions
BEGIN SELECT RAISE(ABORT, 'local administrator state revisions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER local_admin_state_no_delete
BEFORE DELETE ON local_admin_state_revisions
BEGIN SELECT RAISE(ABORT, 'local administrator state revisions are immutable'); END;
