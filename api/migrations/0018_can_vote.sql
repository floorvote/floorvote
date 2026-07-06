-- api/migrations/0018_can_vote.sql
ALTER TABLE users ADD COLUMN can_vote INTEGER NOT NULL DEFAULT 1;
