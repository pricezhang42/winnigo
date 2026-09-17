CREATE TABLE `listings` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`payload` text NOT NULL,
	`hidden` integer DEFAULT 0 NOT NULL,
	`override` text
);
--> statement-breakpoint
CREATE INDEX `idx_listings_source` ON `listings` (`source`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`checked_at` text NOT NULL,
	`attempted_at` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`error` text
);
