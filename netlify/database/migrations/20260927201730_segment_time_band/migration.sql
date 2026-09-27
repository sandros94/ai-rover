-- Stored rules move from a distance band to a planned drive time band: missions written before
-- this migration gain the time band at its default and lose the distance band, and gain the
-- exploration weights at their default, so the rules parser accepts only the current shape.
UPDATE "mission" SET "config" = jsonb_set("config", '{rules,segmentTimeBand}', '{"minS":900,"maxS":7200}'::jsonb) WHERE "config" ? 'rules' AND NOT ("config" -> 'rules' ? 'segmentTimeBand');--> statement-breakpoint
UPDATE "mission" SET "config" = "config" #- '{rules,segmentDistanceBand}' WHERE "config" -> 'rules' ? 'segmentDistanceBand';--> statement-breakpoint
UPDATE "mission" SET "config" = jsonb_set("config", '{rules,explorationWeights}', '{"pathInFog":0.4,"goalInFog":0.3,"pocket":0.3}'::jsonb) WHERE "config" ? 'rules' AND NOT ("config" -> 'rules' ? 'explorationWeights');--> statement-breakpoint
-- Submissions judged before exploration was measured take the parts their stored metrics hold
-- (the pocket needs the mission's history then, so it stays 0) and the code's value alone at the
-- default weights: Jev was never asked, and asking now would judge another plan.
ALTER TABLE "submission" ADD COLUMN "exploration" double precision;--> statement-breakpoint
ALTER TABLE "submission" ADD COLUMN "exploration_parts" jsonb;--> statement-breakpoint
UPDATE "submission" SET "exploration_parts" = jsonb_build_object(
	'pathInFog', CASE WHEN ("metrics" ->> 'reached')::boolean THEN coalesce(("metrics" ->> 'unrevealedFraction')::double precision, 0) ELSE 0 END,
	'goalInFog', CASE WHEN coalesce(("metrics" ->> 'goalInFog')::boolean, false) THEN 1 ELSE 0 END,
	'pocket', 0
);--> statement-breakpoint
UPDATE "submission" SET "exploration" = 0.4 * ("exploration_parts" ->> 'pathInFog')::double precision + 0.3 * ("exploration_parts" ->> 'goalInFog')::double precision;--> statement-breakpoint
ALTER TABLE "submission" ALTER COLUMN "exploration" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "submission" ALTER COLUMN "exploration_parts" SET NOT NULL;
