import { afterAll, beforeAll } from 'vitest'
import { countStrategy } from '../../src/routes/billsApi/facetCounts'
import { randomFixtureSuite } from './groupFacetsHarness'

// The complement form (see groupFacetsRandom6) with the keys of the current result off, so that a count under OR tests each bill
// against the filter, and with the provider anchors under AND.
const { complement, keysMax } = countStrategy
beforeAll(() => { countStrategy.complement = 'always'; countStrategy.keysMax = 0 })
afterAll(() => { countStrategy.complement = complement; countStrategy.keysMax = keysMax })

randomFixtureSuite(7, ['AND', 'OR'], 'provider')
