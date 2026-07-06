-- Indexes for the bills list endpoint sort and filter columns
CREATE INDEX idx_bills_last_action_date ON bills(last_action_date DESC);
CREATE INDEX idx_bills_status           ON bills(status);
CREATE INDEX idx_bills_session          ON bills(session);
CREATE INDEX idx_bills_relevance_score  ON bills(relevance_score DESC);
CREATE INDEX idx_bills_bill_number      ON bills(bill_number);
CREATE INDEX idx_bills_state            ON bills(state);
CREATE INDEX idx_bills_updated_at       ON bills(updated_at DESC);
