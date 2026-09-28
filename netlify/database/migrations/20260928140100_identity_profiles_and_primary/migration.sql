DROP INDEX "user_identity_user_idx";--> statement-breakpoint
ALTER TABLE "user_account" ADD COLUMN "primary_provider" text;--> statement-breakpoint
ALTER TABLE "user_identity" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "user_identity" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "user_identity" ADD COLUMN "handle" text;--> statement-breakpoint
UPDATE "user_identity" SET "display_name" = "user_account"."display_name", "avatar_url" = "user_account"."avatar_url", "handle" = "user_account"."handle" FROM "user_account" WHERE "user_account"."id" = "user_identity"."user_id";--> statement-breakpoint
ALTER TABLE "user_identity" ALTER COLUMN "display_name" SET NOT NULL;--> statement-breakpoint
UPDATE "user_account" SET "primary_provider" = (SELECT "provider" FROM "user_identity" WHERE "user_identity"."user_id" = "user_account"."id" ORDER BY "created_at", "provider" LIMIT 1);--> statement-breakpoint
ALTER TABLE "user_identity" ADD CONSTRAINT "user_identity_user_provider_unique" UNIQUE("user_id","provider");--> statement-breakpoint
ALTER TABLE "user_account" ADD CONSTRAINT "user_account_primary_provider_check" CHECK ("primary_provider" is null or "primary_provider" in ('github', 'discord', 'atproto'));
