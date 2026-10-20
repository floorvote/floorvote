-- Which provider central reads each state from (#292), in place of the
-- LIMS_STATES, MGA_STATES, and LIS_STATES env vars. A state with no row is
-- LegiScan's, so a LegiScan-only central needs no rows at all.
--
-- An admin claim (POST /api/admin/state-providers/:state) writes a row. It is
-- refused, and the row left as it is, while the state's current provider has
-- bills linked to an instance: only a cutover moves those. For one release the
-- syncs also seed a row from those env vars, under the same rule, for a state
-- that has none (lib/stateProviders.ts).
--
-- status is 'active' on every row written so far. previous_provider is the
-- provider the state had before the row was last written ('legiscan' for a
-- state claimed from no row), and claimed_at is when that happened.
--
-- A new table only. Nothing reads from or copies into it here.
CREATE TABLE IF NOT EXISTS state_providers (
  state             TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  previous_provider TEXT,
  claimed_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
