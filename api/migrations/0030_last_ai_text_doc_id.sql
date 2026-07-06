-- 0030_last_ai_text_doc_id.sql
-- Track which bill_texts version was used to generate the current AI summary,
-- so the UI can link "Based on text [type · date]" to the right document.
ALTER TABLE bills ADD COLUMN last_ai_text_doc_id TEXT;

-- Backfill: for each bill that already has ai_processed_at set, point at the
-- most recent text version. Ordering by date desc, doc_id desc gives a
-- deterministic newest-text pick when dates tie. Bills with ai_processed_at
-- but zero text rows leave last_ai_text_doc_id as NULL.
UPDATE bills
SET last_ai_text_doc_id = (
  SELECT doc_id FROM bill_texts
  WHERE bill_texts.bill_id = bills.id
  ORDER BY date DESC, doc_id DESC
  LIMIT 1
)
WHERE ai_processed_at IS NOT NULL;
