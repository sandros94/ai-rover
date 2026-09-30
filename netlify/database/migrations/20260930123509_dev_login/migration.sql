ALTER TABLE "user_account" ADD COLUMN "dev_login" text;--> statement-breakpoint
ALTER TABLE "user_account" ADD CONSTRAINT "user_account_dev_login_key" UNIQUE("dev_login");