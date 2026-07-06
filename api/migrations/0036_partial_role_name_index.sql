DROP INDEX IF EXISTS idx_roles_name_lower;
CREATE UNIQUE INDEX idx_roles_name_lower ON roles (lower(name)) WHERE deleted_at IS NULL;
