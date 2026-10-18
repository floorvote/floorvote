-- One name per filter (#699). A saved view stores a serialized bill filter, a
-- query string, and three of its keys were renamed:
--   q            becomes search
--   cf_<slug>    becomes field.<slug> (a field named by its id too)
--   session      becomes sessionName
-- The API has no aliases for the old keys, so this rewrites every stored view
-- to the new ones. Every other byte of a query stays as it was.
--
-- A key starts a query or follows an ampersand, and an ampersand or an equals
-- sign inside a value is percent-encoded, so wrapping the query in ampersands
-- and replacing "&q=" and the like rewrites keys and never values. A key with
-- no value ("&q&") is rewritten too, twice over since a replace does not see
-- the second of two such keys in a row. A query stored with a leading question
-- mark keeps it.
--
-- Idempotent: no new key starts with an old one ("&sessionName=" does not hold
-- "&session="), so a second run finds nothing to rewrite. Only views whose query
-- changes are written, so the others, and every updated_at, stay untouched.
UPDATE saved_views
SET query = rewritten.query
FROM (
  SELECT id, lead || SUBSTR(wrapped, 2, LENGTH(wrapped) - 2) AS query
  FROM (
    SELECT id, lead,
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        '&' || body || '&',
        '&q=', '&search='),
        '&q&', '&search&'),
        '&q&', '&search&'),
        '&session=', '&sessionName='),
        '&session&', '&sessionName&'),
        '&session&', '&sessionName&'),
        '&cf_', '&field.') AS wrapped
    FROM (
      SELECT id,
        CASE WHEN SUBSTR(query, 1, 1) = '?' THEN '?' ELSE '' END AS lead,
        CASE WHEN SUBSTR(query, 1, 1) = '?' THEN SUBSTR(query, 2) ELSE query END AS body
      FROM saved_views
    )
  )
) AS rewritten
WHERE saved_views.id = rewritten.id AND saved_views.query <> rewritten.query;
