-- 0047_committee_registry.sql
-- The committees each instance picked in its Bill committees card (#471). A
-- bill referred to one, or pending in one, is fully analyzed for that
-- instance, as a keyword match is. Instances send their list at registration,
-- as they send their keywords, and an empty list clears it. committee_id is
-- the committees row's id.

CREATE TABLE IF NOT EXISTS committee_registry (
  tenant_id    TEXT NOT NULL,
  committee_id INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, committee_id)
);
