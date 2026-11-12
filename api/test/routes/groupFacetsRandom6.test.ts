import { afterAll, beforeAll } from 'vitest'
import { countStrategy } from '../../src/routes/billsApi/facetCounts'
import { randomFixtureSuite } from './groupFacetsHarness'

// Every count of the subject and committee rows reads the rows of the bills a filter leaves out and subtracts them from every
// row (#1023), the form a filter most bills meet takes. The fixture's filters are narrow, so the form is forced, and every
// count is checked against the list under both operators (under OR the current result is held as keys).
const complement = countStrategy.complement
beforeAll(() => { countStrategy.complement = 'always' })
afterAll(() => { countStrategy.complement = complement })

randomFixtureSuite(6)
