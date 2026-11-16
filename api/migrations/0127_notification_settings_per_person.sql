-- How each email is chosen moves to each person (floorvote/floorvote#1033). An admin keeps one switch for all
-- notification emails (notification_emails_enabled, missing means on) and the week ahead day (week_ahead_day).
-- Everything else is each person's own. Nobody's email changes: where the team had an email off, each person's
-- switch for it goes off, and they can turn it back on.
--
-- This reads the modules row first and removes its email entries last, so the order of the statements matters.

-- 1. New bills is each person's own switch now, for every role (email_digest_matches_enabled, already on by default).
-- Someone with the digest switch off got no new bills, so theirs goes off. An admin or owner with the digest switch on
-- got every new bill whatever the column said, so theirs goes on. A member keeps their own value.
UPDATE users SET email_digest_matches_enabled = 0 WHERE email_digest_enabled = 0;
UPDATE users SET email_digest_matches_enabled = 1 WHERE email_digest_enabled = 1 AND role IN ('admin', 'owner');

-- 2. How often the digest comes is each person's: NULL every morning, or a weekday 0 (Sunday) to 6 (Saturday), UTC.
ALTER TABLE users ADD COLUMN email_digest_weekly_day INTEGER;

-- A team whose digest is weekly today makes everyone weekly on the team's day (Monday when none was saved, as the digest
-- read it), so nobody's digest changes. That holds while the digest is off too, so turning it back on brings back the
-- weekly digest. People added later start on the same day (digest_weekly_day_for_new_people).
UPDATE users SET email_digest_weekly_day = (
  SELECT CAST(COALESCE(json_extract(value, '$."email-digest".settings.weeklyDay'), '1') AS INTEGER)
  FROM association_config WHERE key = 'modules' AND json_valid(value)
)
WHERE (SELECT json_extract(value, '$."email-digest".settings.frequency') FROM association_config WHERE key = 'modules' AND json_valid(value)) = 'weekly';

-- Each weekday's digest keeps its own window (last_weekly_digest_at_<day>). On a weekly team, the team's day carries on
-- from the last digest, which was weekly.
INSERT INTO association_config (key, value)
SELECT 'last_weekly_digest_at_' || (
  SELECT CAST(COALESCE(json_extract(value, '$."email-digest".settings.weeklyDay'), '1') AS INTEGER)
  FROM association_config WHERE key = 'modules' AND json_valid(value)
), value
FROM association_config
WHERE key = 'last_digest_at'
  AND (SELECT json_extract(value, '$."email-digest".settings.frequency') FROM association_config WHERE key = 'modules' AND json_valid(value)) = 'weekly';

INSERT INTO association_config (key, value)
SELECT 'digest_weekly_day_for_new_people', CAST(CAST(COALESCE(json_extract(value, '$."email-digest".settings.weeklyDay'), '1') AS INTEGER) AS TEXT)
FROM association_config
WHERE key = 'modules' AND json_valid(value)
  AND json_extract(value, '$."email-digest".settings.frequency') = 'weekly';

-- 3. Where the team's digest was off, each person's digest switches go off and so do their followed views, since the
-- followed views were part of the digest. No modules row, or one that can't be read, counts as off.
UPDATE users SET email_digest_enabled = 0, email_digest_matches_enabled = 0
WHERE NOT EXISTS (
  SELECT 1 FROM association_config
  WHERE key = 'modules' AND json_valid(value)
    AND (json_type(value, '$."email-digest"') = 'true' OR json_extract(value, '$."email-digest".enabled') = 1)
);
DELETE FROM saved_view_subscriptions
WHERE NOT EXISTS (
  SELECT 1 FROM association_config
  WHERE key = 'modules' AND json_valid(value)
    AND (json_type(value, '$."email-digest"') = 'true' OR json_extract(value, '$."email-digest".enabled') = 1)
);

-- 4. The same for the week ahead email.
UPDATE users SET email_week_ahead_enabled = 0
WHERE NOT EXISTS (
  SELECT 1 FROM association_config
  WHERE key = 'modules' AND json_valid(value)
    AND (json_type(value, '$."week-ahead"') = 'true' OR json_extract(value, '$."week-ahead".enabled') = 1)
);

-- 5. The week ahead day is an instance setting now. Monday when none was saved, as the email read it. An instance with
-- no people has nothing to keep (a new database has none when its migrations run), so it saves nothing and reads Friday.
INSERT INTO association_config (key, value)
SELECT 'week_ahead_day', CAST(COALESCE(
  (SELECT CAST(COALESCE(json_extract(value, '$."week-ahead".settings.weeklyDay'), '1') AS INTEGER)
   FROM association_config WHERE key = 'modules' AND json_valid(value)),
  1) AS TEXT)
WHERE EXISTS (SELECT 1 FROM users);

-- 6. Drop what nothing reads any more.
UPDATE association_config SET value = json_remove(value, '$."email-digest"', '$."week-ahead"')
WHERE key = 'modules' AND json_valid(value);
DELETE FROM association_config WHERE key = 'mention_emails_enabled';
