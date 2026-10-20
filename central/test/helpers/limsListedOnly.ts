import bulkRaw from '../fixtures/lims/bulk-records.json?raw'
import details0400Raw from '../fixtures/lims/details-B26-0400.json?raw'

const bulk = JSON.parse(bulkRaw) as Record<string, { title: string }>

/**
 * The LegislationDetails of a bill the recorded BulkData lists but whose
 * details weren't recorded: B26-0400's, renumbered, with the bill's own title,
 * no hearings, actions, or reviews, and document ids of its own (`n` prefixes
 * them, so no two bills share one). LIMS declares ingestAll (#835), so a pass
 * queues every listed bill, and a feed must answer each one's details.
 */
export function listedOnlyDetails(number: string, n: number) {
  return {
    ...JSON.parse(details0400Raw.replaceAll('B26-0400', number).replace(/Id=(\d+)/g, `Id=${n}$1`)),
    legislationId: 70000 + n, title: bulk[number].title, status: 'Under Council Review',
    additionalInformation: null, committeeHearing: [], committeeMarkup: [], actions: [], otherDocuments: [],
    mayoralReview: null, congressionalReview: null,
  }
}
