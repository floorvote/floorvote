-- What a provider keeps between runs (ProviderContext.cache, lib/providerCache.ts):
-- small text entries under keys the provider names, for what it fetched once and
-- shouldn't fetch again. GovInfo keeps each committee meeting it read from the
-- Congress.gov API here, since the API answers one request per meeting and
-- allows 10 a minute, and a run can't read a whole Congress's in the time it has.
-- Each provider's entries are its own, and nothing expires: the provider drops
-- what it no longer needs.

CREATE TABLE provider_cache (
  provider   TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, key)
) WITHOUT ROWID;
