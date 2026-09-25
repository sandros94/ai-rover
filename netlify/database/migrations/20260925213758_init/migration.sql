CREATE TABLE "mission" (
	"id" uuid PRIMARY KEY,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seed" text NOT NULL,
	"world_hash" text NOT NULL,
	"config" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_stop_id" uuid,
	"sols_epoch" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_status_check" CHECK ("status" in ('active', 'ended')),
	CONSTRAINT "mission_world_hash_check" CHECK ("world_hash" ~ '^[0-9a-f]{16}$')
);
--> statement-breakpoint
CREATE TABLE "round" (
	"id" uuid PRIMARY KEY,
	"mission_id" uuid NOT NULL,
	"from_stop_id" uuid NOT NULL,
	"opens_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closes_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"winner_submission_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "round_status_check" CHECK ("status" in ('open', 'closed')),
	CONSTRAINT "round_winner_check" CHECK (("status" = 'open' and "winner_submission_id" is null) or ("status" = 'closed' and "winner_submission_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "segment" (
	"id" uuid PRIMARY KEY,
	"mission_id" uuid NOT NULL,
	"round_id" uuid NOT NULL CONSTRAINT "segment_round_unique" UNIQUE,
	"submission_id" uuid NOT NULL CONSTRAINT "segment_submission_unique" UNIQUE,
	"from_stop_id" uuid NOT NULL,
	"to_stop_id" uuid,
	"status" text DEFAULT 'driving' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"manifest_key" text NOT NULL,
	"outcome" jsonb,
	"death_x" double precision,
	"death_y" double precision,
	"attempt" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segment_status_check" CHECK ("status" in ('driving', 'arrived', 'stopped-short', 'failed')),
	CONSTRAINT "segment_attempt_check" CHECK ("attempt" >= 1),
	CONSTRAINT "segment_window_check" CHECK ("ends_at" >= "started_at"),
	CONSTRAINT "segment_settled_check" CHECK (case "status"
        when 'driving' then "to_stop_id" is null and "death_x" is null and "death_y" is null
        when 'failed' then "to_stop_id" is null and "death_x" is not null and "death_y" is not null
        else "to_stop_id" is not null and "death_x" is null and "death_y" is null
      end)
);
--> statement-breakpoint
CREATE TABLE "stop" (
	"id" uuid PRIMARY KEY,
	"mission_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"heading_rad" double precision NOT NULL,
	"manifest_key" text NOT NULL,
	"revealed_key" text NOT NULL,
	"from_segment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stop_mission_index_unique" UNIQUE("mission_id","index"),
	CONSTRAINT "stop_index_check" CHECK ("index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "submission" (
	"id" uuid PRIMARY KEY,
	"round_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"goal_x" double precision NOT NULL,
	"goal_y" double precision NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"judgment" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_status_check" CHECK ("status" in ('open', 'rejected', 'won', 'lost', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "submission_like" (
	"submission_id" uuid,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submission_like_pkey" PRIMARY KEY("submission_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "user_account" (
	"id" uuid PRIMARY KEY,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"handle" text
);
--> statement-breakpoint
CREATE TABLE "user_identity" (
	"provider" text,
	"subject" text,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identity_pkey" PRIMARY KEY("provider","subject"),
	CONSTRAINT "user_identity_provider_check" CHECK ("provider" in ('github', 'atproto'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "round_open_per_mission_idx" ON "round" ("mission_id") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX "round_mission_idx" ON "round" ("mission_id");--> statement-breakpoint
CREATE INDEX "segment_mission_from_stop_idx" ON "segment" ("mission_id","from_stop_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_open_per_user_idx" ON "submission" ("round_id","user_id") WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX "submission_round_idx" ON "submission" ("round_id");--> statement-breakpoint
CREATE INDEX "user_identity_user_idx" ON "user_identity" ("user_id");--> statement-breakpoint
ALTER TABLE "mission" ADD CONSTRAINT "mission_current_stop_id_stop_id_fkey" FOREIGN KEY ("current_stop_id") REFERENCES "stop"("id");--> statement-breakpoint
ALTER TABLE "round" ADD CONSTRAINT "round_mission_id_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "mission"("id");--> statement-breakpoint
ALTER TABLE "round" ADD CONSTRAINT "round_from_stop_id_stop_id_fkey" FOREIGN KEY ("from_stop_id") REFERENCES "stop"("id");--> statement-breakpoint
ALTER TABLE "round" ADD CONSTRAINT "round_winner_submission_id_submission_id_fkey" FOREIGN KEY ("winner_submission_id") REFERENCES "submission"("id");--> statement-breakpoint
ALTER TABLE "segment" ADD CONSTRAINT "segment_mission_id_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "mission"("id");--> statement-breakpoint
ALTER TABLE "segment" ADD CONSTRAINT "segment_round_id_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "round"("id");--> statement-breakpoint
ALTER TABLE "segment" ADD CONSTRAINT "segment_submission_id_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submission"("id");--> statement-breakpoint
ALTER TABLE "segment" ADD CONSTRAINT "segment_from_stop_id_stop_id_fkey" FOREIGN KEY ("from_stop_id") REFERENCES "stop"("id");--> statement-breakpoint
ALTER TABLE "segment" ADD CONSTRAINT "segment_to_stop_id_stop_id_fkey" FOREIGN KEY ("to_stop_id") REFERENCES "stop"("id");--> statement-breakpoint
ALTER TABLE "stop" ADD CONSTRAINT "stop_mission_id_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "mission"("id");--> statement-breakpoint
ALTER TABLE "stop" ADD CONSTRAINT "stop_from_segment_id_segment_id_fkey" FOREIGN KEY ("from_segment_id") REFERENCES "segment"("id");--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_round_id_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "round"("id");--> statement-breakpoint
ALTER TABLE "submission" ADD CONSTRAINT "submission_user_id_user_account_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id");--> statement-breakpoint
ALTER TABLE "submission_like" ADD CONSTRAINT "submission_like_submission_id_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submission"("id");--> statement-breakpoint
ALTER TABLE "submission_like" ADD CONSTRAINT "submission_like_user_id_user_account_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id");--> statement-breakpoint
ALTER TABLE "user_identity" ADD CONSTRAINT "user_identity_user_id_user_account_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_account"("id");