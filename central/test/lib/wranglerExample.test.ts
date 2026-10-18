import { describe, it, expect } from 'vitest'
import exampleRaw from '../../wrangler.example.toml?raw'
import { PROVIDERS } from '../../src/providers'

// Every provider that declares its own ingest queue is an operator's option, so
// the example config carries a commented producer binding and consumer for it,
// next to the others, with the provider's concurrency and a comment saying why.
const declared = PROVIDERS.flatMap(p => (p.ingestQueue ? [{ id: p.id, binding: p.ingestQueue }] : []))

/** The commented block that starts at a provider's producer binding and runs to the next blank line. */
function blockFor(binding: string): string[] {
  const lines = exampleRaw.split('\n')
  const at = lines.findIndex(l => l.trim() === `# binding = "${binding}"`)
  expect(at, `${binding} has no commented binding in wrangler.example.toml`).toBeGreaterThan(-1)
  let start = at
  while (start > 0 && lines[start - 1].startsWith('#') && lines[start - 1].trim() !== '#') start--
  let end = at
  while (end < lines.length - 1 && lines[end + 1].startsWith('#') && lines[end + 1].trim() !== '#') end++
  return lines.slice(start, end + 1)
}

describe('wrangler.example.toml', () => {
  it('declares each provider queue the registry knows', () => {
    expect(declared.map(d => d.binding).sort()).toEqual(['LIMS_INGESTOR_QUEUE', 'LIS_INGESTOR_QUEUE', 'MGA_INGESTOR_QUEUE'])
  })

  it.each(declared)('carries a commented producer and consumer for $binding, at max_concurrency = 1, with a comment saying why', ({ binding }) => {
    const block = blockFor(binding).join('\n')
    const queueName = block.match(/# binding = "[A-Z_]+"\n# queue = "([a-z-]+)"/)?.[1]
    expect(queueName, 'a queue name on the producer').toBeTruthy()
    expect(block).toContain('[[env.legiscan.queues.producers]]')
    expect(block).toContain('[[env.legiscan.queues.consumers]]')
    // The consumer reads the queue the producer writes.
    expect(block).toContain(`# queue = "${queueName}"\n# max_batch_size`)
    expect(block).toMatch(/# max_concurrency = 1\b/)
    // A comment above the block says what the queue is for and why the concurrency is what it is.
    expect(block).toMatch(/^# Optional: .*\n(# .*\n)*# \[\[env\.legiscan\.queues\.producers\]\]/)
    expect(block).toMatch(/concurren/i)
  })

  it('gives each provider queue a name of its own, none the shared ingestor queue', () => {
    const names = declared.map(({ binding }) => blockFor(binding).join('\n').match(/# queue = "([a-z-]+)"/)![1])
    expect(new Set(names).size).toBe(names.length)
    expect(names).not.toContain('central-legiscan-ingestor')
  })

  it('keeps the shared ingestor queue bound and uncommented, at max_concurrency = 1', () => {
    expect(exampleRaw).toMatch(/\n\[\[env\.legiscan\.queues\.producers\]\]\nbinding = "INGESTOR_QUEUE"\nqueue = "central-legiscan-ingestor"/)
    expect(exampleRaw).toMatch(/\nmax_concurrency = 1\n/)
  })

  it('binds no provider queue by default, so a LegiScan-only deployment changes nothing', () => {
    for (const { binding } of declared) expect(exampleRaw).not.toMatch(new RegExp(`^binding = "${binding}"`, 'm'))
  })
})
