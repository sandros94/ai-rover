-- Rows written before this migration are backfilled: a round is anchored on the stop it was
-- opened from, and a rejection could then only come from Jev's verdict.
ALTER TABLE "round" ADD COLUMN "anchor_x" double precision;--> statement-breakpoint
ALTER TABLE "round" ADD COLUMN "anchor_y" double precision;--> statement-breakpoint
UPDATE "round" SET "anchor_x" = "stop"."x", "anchor_y" = "stop"."y" FROM "stop" WHERE "stop"."id" = "round"."from_stop_id";--> statement-breakpoint
ALTER TABLE "round" ALTER COLUMN "anchor_x" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "round" ALTER COLUMN "anchor_y" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "submission" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
UPDATE "submission" SET "rejection_reason" = 'judged-infeasible' WHERE "status" = 'rejected';--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_rejection_check" CHECK (("status" = 'rejected' and "rejection_reason" is not null and "rejection_reason" in ('judged-infeasible', 'invalidated-by-stop')) or ("status" <> 'rejected' and "rejection_reason" is null));--> statement-breakpoint
ALTER TABLE "round" DROP CONSTRAINT "round_status_check", ADD CONSTRAINT "round_status_check" CHECK ("status" in ('open', 'closed', 'void'));--> statement-breakpoint
ALTER TABLE "round" DROP CONSTRAINT "round_winner_check", ADD CONSTRAINT "round_winner_check" CHECK (("status" in ('open', 'void') and "winner_submission_id" is null) or ("status" = 'closed' and "winner_submission_id" is not null));
