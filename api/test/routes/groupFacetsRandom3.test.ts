import { afterAll, beforeAll } from 'vitest'
import { freshForm } from '../../src/routes/billsApi/facetCounts'
import { randomFixtureSuite } from './groupFacetsHarness'

// Under OR a facet counts the groups the value would add, those with no bill in the current result, in one of
// two forms: a per-bill test for a small filter, and a list of the bills in the result, read once, for a filter
// too large to hold twice (facetCounts.ts, `freshOf`). The other files run the first form on small filters, so
// this runs the second on the same fixture and checks it against the list.
const perBillMax = freshForm.perBillMax
beforeAll(() => { freshForm.perBillMax = 0 })
afterAll(() => { freshForm.perBillMax = perBillMax })

randomFixtureSuite(1, ['OR'])
