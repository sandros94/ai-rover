-- Missions stored before the stop radius was a rule keep the radius their stops were published with.
UPDATE "mission" SET "config" = jsonb_set("config", '{rules,stopRadiusM}', '500') WHERE NOT ("config" -> 'rules' ? 'stopRadiusM');
