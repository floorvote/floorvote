-- Optional "internal users excluded" variant of the user-attributable engagement
-- metrics, so the Adoption page can toggle out activity from configured internal
-- email domains (e.g. bipartisanpolicy.org). Stored as a JSON object of the six
-- excludable metrics -- total_members, active_members_7d, active_members_30d,
-- votes_cast, comments_written, comment_reactions -- computed tenant-side at pull
-- time when an exclusion domain list is configured, and left NULL otherwise.
-- Historical rows stay NULL, so the toggle falls back to the full value there.
ALTER TABLE tenant_stats ADD COLUMN excluded_json TEXT;
