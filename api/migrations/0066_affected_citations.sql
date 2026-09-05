-- Statutory citations a bill affects, as the analysis model reported them.
--
-- Stored verbatim, exactly as printed in the bill (a JSON array of strings) —
-- "17-70-401", "RCW 29A.04.008", whatever that state prints. Deliberately NOT
-- normalised: citation formats differ enough between states that a canonical
-- shape would be a guess until there is more than one state to compare. Parse
-- on read when a consumer needs structure.
--
-- Written by the bill analysis pipeline and not yet surfaced in the UI.
ALTER TABLE bills ADD COLUMN affected_citations TEXT NOT NULL DEFAULT '[]';
