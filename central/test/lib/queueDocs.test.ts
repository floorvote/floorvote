import { describe, it, expect } from 'vitest'
import syncPipeline from '../../../docs/internal/sync-pipeline.md?raw'
import providerGuide from '../../../docs/content/contributing/providers.md?raw'

// The operator runbook and the provider guide both tell an operator to bind a
// provider's ingest queue before claiming or cutting over a large state (#401).
describe('the queue docs', () => {
  it.each([
    ['the cutover runbook (sync-pipeline.md)', syncPipeline],
    ['the provider guide (providers.md)', providerGuide],
  ])('%s says to bind a provider\'s queue before a large cutover', (_name, doc) => {
    expect(doc).toMatch(/binds? (the provider's|its) queue before claiming or cutting over a large state/i)
  })

  it('names every provider queue binding in the runbook', () => {
    for (const binding of ['LIMS_INGESTOR_QUEUE', 'MGA_INGESTOR_QUEUE', 'LIS_INGESTOR_QUEUE']) expect(syncPipeline).toContain(binding)
  })

  it('no longer says MGA and LIS declare no queue', () => {
    expect(syncPipeline).not.toMatch(/MGA and LIS\*\* declare no queue/)
  })
})
