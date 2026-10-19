import { randomFixtureSuite } from './groupFacetsHarness'

// The provider facts that were never the active filter (state, stage, year, session) and drafts, under both operators.
randomFixtureSuite(4, ['AND', 'OR'], 'provider')
