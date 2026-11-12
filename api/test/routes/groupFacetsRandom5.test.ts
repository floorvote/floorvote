import { afterAll, beforeAll } from 'vitest'
import { countStrategy, freshForm } from '../../src/routes/billsApi/facetCounts'
import { randomFixtureSuite } from './groupFacetsHarness'

// The same anchors under OR in the form of a filter too large to hold twice (see groupFacetsRandom3).
// The result is held as keys under OR when it is small (#1023), so that form is turned off to run the list form.
const perBillMax = freshForm.perBillMax
const keysMax = countStrategy.keysMax
beforeAll(() => { freshForm.perBillMax = 0; countStrategy.keysMax = 0 })
afterAll(() => { freshForm.perBillMax = perBillMax; countStrategy.keysMax = keysMax })

randomFixtureSuite(5, ['OR'], 'provider')
