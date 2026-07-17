CREATE TABLE `local_delivery_commands` (
	`key` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`response` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `local_delivery_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`revision` integer NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_delivery_event_revision_unique` ON `local_delivery_events` (`project_id`,`revision`);--> statement-breakpoint
CREATE INDEX `local_delivery_event_project_time_idx` ON `local_delivery_events` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `local_delivery_snapshots` (
	`project_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`snapshot` text NOT NULL,
	`updated_at` text NOT NULL
);
