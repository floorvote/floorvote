-- Provider extras (#293): values of fields only one provider publishes, such
-- as a DC law number, shown on the bill page under the provider's name. Each
-- provider's vocabulary file declares its extras (label, explainer, display
-- type), so only the value is stored here, one row per bill, provider, and key.
--
-- The ingest replaces a bill's rows on every ingest, like its other child
-- data. Nothing sorts, filters, notifies, or runs AI on these values. A field
-- that needs any of that becomes a shared column instead.
--
-- A new table only. Nothing reads from or copies into it here.
CREATE TABLE IF NOT EXISTS bill_extras (
  bill_id  INTEGER NOT NULL,
  provider TEXT NOT NULL,
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (bill_id, provider, key)
);
