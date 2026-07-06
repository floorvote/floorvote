-- bills: new priority column (replaces is_priority conceptually - is_priority kept as deprecated no-op)
ALTER TABLE bills ADD COLUMN priority TEXT CHECK (priority IN ('high', 'medium', 'low')) DEFAULT NULL;
ALTER TABLE bills ADD COLUMN sponsor TEXT;
ALTER TABLE bills ADD COLUMN sponsor_party TEXT;
ALTER TABLE bills ADD COLUMN last_action TEXT;
ALTER TABLE bills ADD COLUMN last_action_date TEXT;
ALTER TABLE bills ADD COLUMN history TEXT;
ALTER TABLE bills ADD COLUMN related_bill_ids TEXT;
ALTER TABLE bills ADD COLUMN companion_bill_ids TEXT;

-- users: subtitle for display in comments and vote breakdowns
ALTER TABLE users ADD COLUMN subtitle TEXT;

CREATE INDEX idx_bills_priority ON bills(priority) WHERE priority IS NOT NULL;
