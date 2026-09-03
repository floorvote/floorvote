-- Legislature subject terms, mirrored from central. Central is authoritative and
-- delete-and-reinserts per refresh; the tenant replaces a bill's rows on each write.
ALTER TABLE bills ADD COLUMN subjects TEXT;

CREATE TABLE IF NOT EXISTS bill_subjects (
  bill_id      TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  subject_name TEXT NOT NULL,
  state        TEXT NOT NULL,
  PRIMARY KEY (bill_id, subject_name)
);

-- Facet counts group by (state, subject_name); the filter looks up by name.
CREATE INDEX IF NOT EXISTS idx_bill_subjects_name ON bill_subjects(state, subject_name);
