CREATE TABLE "mission_pause" (
	"id" uuid PRIMARY KEY,
	"mission_id" uuid NOT NULL,
	"message" text NOT NULL,
	"paused_by" uuid NOT NULL,
	"paused_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resumed_at" timestamp with time zone,
	CONSTRAINT "mission_pause_window_check" CHECK ("resumed_at" is null or "resumed_at" >= "paused_at")
);
--> statement-breakpoint
CREATE TABLE "segment_flag" (
	"segment_id" uuid,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segment_flag_pkey" PRIMARY KEY("segment_id","user_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mission_pause_active_idx" ON "mission_pause" ("mission_id") WHERE "resumed_at" is null;--> statement-breakpoint
ALTER TABLE "mission_pause" ADD CONSTRAINT "mission_pause_mission_id_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "mission"("id");--> statement-breakpoint
ALTER TABLE "mission_pause" ADD CONSTRAINT "mission_pause_paused_by_user_account_id_fkey" FOREIGN KEY ("paused_by") REFERENCES "user_account"("id");--> statement-breakpoint
ALTER TABLE "segment_flag" ADD CONSTRAINT "segment_flag_segment_id_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segment"("id");--> statement-breakpoint
ALTER TABLE "segment_flag" ADD CONSTRAINT "segment_flag_user_id_user_account_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id");--> statement-breakpoint
-- Missions stored before the not-moving rules take the defaults the code ships with.
UPDATE "mission" SET "config" = jsonb_set("config", '{rules,notMoving}', '{"quorumMax":5,"quorumMin":2,"windowMs":600000,"progressM":0.5,"backstopMs":900000}'::jsonb) WHERE NOT ("config" -> 'rules' ? 'notMoving');
