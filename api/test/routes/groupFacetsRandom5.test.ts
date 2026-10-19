import { afterAll, beforeAll } from 'vitest'
import { freshForm } from '../../src/routes/billsApi/facetCounts'
import { randomFixtureSuite } from './groupFacetsHarness'

// The same anchors under OR in the form of a filter too large to hold twice (see groupFacetsRandom3).
const perBillMax = freshForm.perBillMax
beforeAll(() => { freshForm.perBillMax = 0 })
afterAll(() => { freshForm.perBillMax = perBillMax })

randomFixtureSuite(5, ['OR'], 'provider')
