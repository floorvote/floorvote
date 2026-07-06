DELETE FROM user_roles;
DELETE FROM roles;
ALTER TABLE roles ADD COLUMN deleted_at TEXT;
ALTER TABLE roles ADD COLUMN deleted_by TEXT;
CREATE UNIQUE INDEX idx_roles_name_lower ON roles (lower(name));
