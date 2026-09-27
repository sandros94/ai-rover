-- Renamed in place, never recreated: cached answers survive, so nothing already judged is paid for again.
ALTER TABLE "jev_judgment" RENAME TO "ai_judgment";--> statement-breakpoint
ALTER TABLE "ai_judgment" RENAME CONSTRAINT "jev_judgment_pkey" TO "ai_judgment_pkey";
