-- The subjects two or more bills of a companion group hold, for the subject facet (#1030).
--
-- The facet counts a group once under a subject however many of its bills hold it. It reads the bills holding the
-- subject, less the grouped bills holding it, plus their groups, and the last two came from a statement over every
-- grouped bill's subject rows into two temporary B-trees of text keys. On the largest instance, with about 15,000
-- grouped bills, that was 100 to 230 ms of database time on every menu request under a filter. A subject held by one
-- bill of a group is no correction, so only the pairs two or more bills hold are kept: one row for each group and
-- subject, with the number of the group's bills that hold it. A tenant whose groups share nothing has no row.
--
-- The correction under a filter is the sum of (n - 1) over the kept groups' rows, as long as every bill of a group
-- meets the filter. A filter on a bill's own columns can leave out one bill of a group, so the facet reads the table
-- only under a filter that cannot split a group, and otherwise counts from the bills' own rows as before. The counts
-- do not change.
--
-- Five triggers keep it right in the statement that changes what it summarizes. A subject row added, removed, or
-- changed in place (its bill, state, or name) recomputes that one pair for the bill's group (both, for a change), and a bill that changes group, or is deleted, recomputes the whole
-- group it left and the one it joined. A bill deleted takes its subject rows with it (ON DELETE CASCADE), and the
-- recompute reads the bills that remain, so it is right whether the rows go before or after the bill. Each recompute
-- reads the bills and their subjects as they are, and never adds or removes by a delta, so a statement that changes
-- many rows cannot leave a count behind. A migration that rebuilds bills must drop and recreate the three triggers on
-- bill_subjects too, since their bodies read bills.
--
-- The backfill is one set-based statement over every grouped bill, never a per-row recompute, which exceeded D1's CPU
-- limit on an instance with thousands of groups (0113).
--
-- No semicolons in these comments. Wrangler ends a CREATE TRIGGER at the first END that follows a semicolon and is
-- followed by one, and the test helpers split this file the same way (shared/sqlStatements.ts).
CREATE TABLE IF NOT EXISTS group_subjects (
  group_key    TEXT NOT NULL,
  state        TEXT NOT NULL,
  subject_name TEXT NOT NULL,
  n            INTEGER NOT NULL,
  PRIMARY KEY (group_key, state, subject_name)
) WITHOUT ROWID;

DELETE FROM group_subjects;

INSERT INTO group_subjects (group_key, state, subject_name, n)
SELECT b.group_key, s.state, s.subject_name, COUNT(*)
FROM bills b JOIN bill_subjects s ON s.bill_id = b.id
WHERE b.group_key IS NOT NULL
GROUP BY b.group_key, s.state, s.subject_name
HAVING COUNT(*) >= 2;

ANALYZE group_subjects;

DROP TRIGGER IF EXISTS bill_subjects_group_subjects_insert;
DROP TRIGGER IF EXISTS bill_subjects_group_subjects_delete;
DROP TRIGGER IF EXISTS bill_subjects_group_subjects_update;
DROP TRIGGER IF EXISTS bills_group_subjects_update;
DROP TRIGGER IF EXISTS bills_group_subjects_delete;

CREATE TRIGGER bill_subjects_group_subjects_insert AFTER INSERT ON bill_subjects
BEGIN
  INSERT INTO group_subjects (group_key, state, subject_name, n)
  SELECT b.group_key, NEW.state, NEW.subject_name, COUNT(*)
  FROM bills b JOIN bill_subjects s ON s.bill_id = b.id
  WHERE b.group_key = (SELECT g.group_key FROM bills g WHERE g.id = NEW.bill_id) AND s.state = NEW.state AND s.subject_name = NEW.subject_name
  GROUP BY b.group_key
  HAVING COUNT(*) >= 2
  ON CONFLICT (group_key, state, subject_name) DO UPDATE SET n = excluded.n;
END;

CREATE TRIGGER bill_subjects_group_subjects_delete AFTER DELETE ON bill_subjects
BEGIN
  INSERT INTO group_subjects (group_key, state, subject_name, n)
  SELECT b.group_key, OLD.state, OLD.subject_name, COUNT(*)
  FROM bills b JOIN bill_subjects s ON s.bill_id = b.id
  WHERE b.group_key = (SELECT g.group_key FROM bills g WHERE g.id = OLD.bill_id) AND s.state = OLD.state AND s.subject_name = OLD.subject_name
  GROUP BY b.group_key
  HAVING COUNT(*) >= 2
  ON CONFLICT (group_key, state, subject_name) DO UPDATE SET n = excluded.n;
  DELETE FROM group_subjects
  WHERE group_key = (SELECT g.group_key FROM bills g WHERE g.id = OLD.bill_id) AND state = OLD.state AND subject_name = OLD.subject_name
    AND (SELECT COUNT(*) FROM bills b JOIN bill_subjects s ON s.bill_id = b.id
         WHERE b.group_key = group_subjects.group_key AND s.state = group_subjects.state AND s.subject_name = group_subjects.subject_name) < 2;
END;

CREATE TRIGGER bill_subjects_group_subjects_update AFTER UPDATE OF bill_id, state, subject_name ON bill_subjects
BEGIN
  INSERT INTO group_subjects (group_key, state, subject_name, n)
  SELECT b.group_key, OLD.state, OLD.subject_name, COUNT(*)
  FROM bills b JOIN bill_subjects s ON s.bill_id = b.id
  WHERE b.group_key = (SELECT g.group_key FROM bills g WHERE g.id = OLD.bill_id) AND s.state = OLD.state AND s.subject_name = OLD.subject_name
  GROUP BY b.group_key
  HAVING COUNT(*) >= 2
  ON CONFLICT (group_key, state, subject_name) DO UPDATE SET n = excluded.n;
  DELETE FROM group_subjects
  WHERE group_key = (SELECT g.group_key FROM bills g WHERE g.id = OLD.bill_id) AND state = OLD.state AND subject_name = OLD.subject_name
    AND (SELECT COUNT(*) FROM bills b JOIN bill_subjects s ON s.bill_id = b.id
         WHERE b.group_key = group_subjects.group_key AND s.state = group_subjects.state AND s.subject_name = group_subjects.subject_name) < 2;
  INSERT INTO group_subjects (group_key, state, subject_name, n)
  SELECT b.group_key, NEW.state, NEW.subject_name, COUNT(*)
  FROM bills b JOIN bill_subjects s ON s.bill_id = b.id
  WHERE b.group_key = (SELECT g.group_key FROM bills g WHERE g.id = NEW.bill_id) AND s.state = NEW.state AND s.subject_name = NEW.subject_name
  GROUP BY b.group_key
  HAVING COUNT(*) >= 2
  ON CONFLICT (group_key, state, subject_name) DO UPDATE SET n = excluded.n;
END;

CREATE TRIGGER bills_group_subjects_update AFTER UPDATE OF group_key ON bills
WHEN NEW.group_key IS NOT OLD.group_key
BEGIN
  DELETE FROM group_subjects WHERE group_key = OLD.group_key;
  INSERT INTO group_subjects (group_key, state, subject_name, n)
  SELECT b.group_key, s.state, s.subject_name, COUNT(*)
  FROM bills b JOIN bill_subjects s ON s.bill_id = b.id
  WHERE b.group_key = OLD.group_key
  GROUP BY b.group_key, s.state, s.subject_name
  HAVING COUNT(*) >= 2;
  DELETE FROM group_subjects WHERE group_key = NEW.group_key;
  INSERT INTO group_subjects (group_key, state, subject_name, n)
  SELECT b.group_key, s.state, s.subject_name, COUNT(*)
  FROM bills b JOIN bill_subjects s ON s.bill_id = b.id
  WHERE b.group_key = NEW.group_key
  GROUP BY b.group_key, s.state, s.subject_name
  HAVING COUNT(*) >= 2;
END;

CREATE TRIGGER bills_group_subjects_delete AFTER DELETE ON bills
WHEN OLD.group_key IS NOT NULL
BEGIN
  DELETE FROM group_subjects WHERE group_key = OLD.group_key;
  INSERT INTO group_subjects (group_key, state, subject_name, n)
  SELECT b.group_key, s.state, s.subject_name, COUNT(*)
  FROM bills b JOIN bill_subjects s ON s.bill_id = b.id
  WHERE b.group_key = OLD.group_key
  GROUP BY b.group_key, s.state, s.subject_name
  HAVING COUNT(*) >= 2;
END;
