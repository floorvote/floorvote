-- Multi-select dropdown custom fields
ALTER TABLE custom_field_definitions ADD COLUMN multiple INTEGER NOT NULL DEFAULT 0;
