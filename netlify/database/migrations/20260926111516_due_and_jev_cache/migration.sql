-- Missions written before this migration are backfilled: due now, so the first read ticks and
-- sets the real instant, and their stored rules gain the per-round attempt cap at its default.
CREATE TABLE "jev_judgment" (
	"hash" text PRIMARY KEY,
	"model" text NOT NULL,
	"answers" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mission" ADD COLUMN "next_due_at" timestamp with time zone;--> statement-breakpoint
UPDATE "mission" SET "next_due_at" = now() WHERE "status" = 'active';--> statement-breakpoint
UPDATE "mission" SET "config" = jsonb_set("config", '{rules,maxJudgedPerRound}', '5') WHERE "config" -> 'rules' -> 'maxJudgedPerRound' IS NULL;
