-- Add slug column for human-readable URL params
ALTER TABLE custom_field_definitions ADD COLUMN slug TEXT;

-- Create unique index on slug
CREATE UNIQUE INDEX idx_custom_field_definitions_slug ON custom_field_definitions(slug);
