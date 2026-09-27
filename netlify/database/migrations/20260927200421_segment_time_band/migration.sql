-- Stored rules move from a distance band to a planned drive time band: missions written before
-- this migration gain the time band at its default and lose the distance band, so the rules
-- parser accepts only the current shape.
UPDATE "mission" SET "config" = jsonb_set("config", '{rules,segmentTimeBand}', '{"minS":900,"maxS":7200}'::jsonb) WHERE "config" ? 'rules' AND NOT ("config" -> 'rules' ? 'segmentTimeBand');--> statement-breakpoint
UPDATE "mission" SET "config" = "config" #- '{rules,segmentDistanceBand}' WHERE "config" -> 'rules' ? 'segmentDistanceBand';
