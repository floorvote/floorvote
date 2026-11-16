-- How often the email digest comes moves from the team to each person: every morning (NULL), or once a week on the
-- weekday they pick (0 Sunday to 6 Saturday, in UTC). The email-digest module's `frequency` and `weeklyDay` are no longer
-- read, and stay as they were for the build that is still serving while the deploy runs.
ALTER TABLE users ADD COLUMN email_digest_weekly_day INTEGER;

-- A team whose digest is weekly today makes everyone weekly on the team's day (Monday when none was saved, as the digest
-- read it), so nobody's digest changes. That holds while the digest is off too, so turning it back on brings back the
-- weekly digest.
UPDATE users SET email_digest_weekly_day = (
  SELECT CAST(COALESCE(json_extract(value, '$."email-digest".settings.weeklyDay'), '1') AS INTEGER)
  FROM association_config WHERE key = 'modules' AND json_valid(value)
)
WHERE (SELECT json_extract(value, '$."email-digest".settings.frequency') FROM association_config WHERE key = 'modules' AND json_valid(value)) = 'weekly';

-- Each weekday's digest keeps its own window from here on (last_weekly_digest_at_<day>). On a weekly team, the team's
-- day carries on from the last digest, which was weekly. last_digest_at goes on as the daily digest's window.
INSERT INTO association_config (key, value)
SELECT 'last_weekly_digest_at_' || (
  SELECT CAST(COALESCE(json_extract(value, '$."email-digest".settings.weeklyDay'), '1') AS INTEGER)
  FROM association_config WHERE key = 'modules' AND json_valid(value)
), value
FROM association_config
WHERE key = 'last_digest_at'
  AND (SELECT json_extract(value, '$."email-digest".settings.frequency') FROM association_config WHERE key = 'modules' AND json_valid(value)) = 'weekly';
