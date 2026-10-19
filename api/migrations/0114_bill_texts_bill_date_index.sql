-- A covering index for a bill's newest text date, which picks a companion
-- group's lead (lib/groupLead.ts). The bill list reads it for each grouped
-- bill on a page and for each grouped bill a bill-number sort orders, and
-- 0113's group_tags triggers read it for each member on every recompute. Each
-- is one MAX over the bill's texts, which this index answers without reading
-- the table. 0113 creates it first, since its backfill needs it, so this is a
-- no-op after 0113. It is also the only index on bill_texts.bill_id: 0025
-- rebuilt bill_texts without 0008's idx_bill_texts_bill_id, so every read of a
-- bill's texts scanned the table until 0113.
CREATE INDEX IF NOT EXISTS idx_bill_texts_bill_date ON bill_texts (bill_id, date);
ANALYZE bill_texts;
