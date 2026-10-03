-- Whether dccouncil.gov's Councilmembers page listed a LIMS member at the last
-- directory sync: 1 listed, 0 not listed, NULL not yet checked. LIMS term dates
-- lag the Council's own page. After Trayon White was expelled and re-elected,
-- LIMS still ended his term at the expulsion.
ALTER TABLE people ADD COLUMN seated INTEGER;
