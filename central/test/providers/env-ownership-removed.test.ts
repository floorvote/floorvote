import { describe, it, expect } from 'vitest'
import { PROVIDERS } from '../../src/providers'
import { providerEnv } from '../../src/lib/providerContext'
import { example } from './example'
import exampleConfigRaw from '../../wrangler.example.toml?raw'
import syncPipelineRaw from '../../../docs/internal/sync-pipeline.md?raw'

// #319: the state_providers table is the only source of state ownership. The
// old LIMS_STATES, MGA_STATES, and LIS_STATES env vars, which seeded rows for
// one release, and each provider's statesEnvKey that named them, are gone.
const OLD_VARS = ['LIMS_STATES', 'MGA_STATES', 'LIS_STATES']
const OLD_PATTERN = new RegExp(`statesEnvKey|${OLD_VARS.join('|')}`)

const sources = import.meta.glob<string>('../../src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true })

describe('the old ownership env vars', () => {
  it.each([...PROVIDERS, example].map(p => [p.id, p] as const))('%s declares no statesEnvKey', (_id, provider) => {
    expect('statesEnvKey' in provider).toBe(false)
    expect(Object.keys(provider)).not.toContain('statesEnvKey')
  })

  it('leaves no provider reading one of them: none lists it among its env keys', () => {
    for (const provider of PROVIDERS) {
      expect(provider.envKeys.filter(k => OLD_VARS.includes(k as string)), provider.id).toEqual([])
    }
    expect([...(PROVIDERS.find(p => p.id === 'lims')!.envKeys)].sort()).toEqual(['LIMS_API_KEY', 'LIMS_CATEGORIES'])
  })

  it('hands a provider none of them, even set on central\'s env', () => {
    const env = { LIMS_API_KEY: 'k', LIMS_STATES: 'DC', MGA_STATES: 'MD', LIS_STATES: 'VA' } as any
    for (const provider of PROVIDERS) {
      expect(Object.keys(providerEnv(provider, env)).filter(k => OLD_VARS.includes(k)), provider.id).toEqual([])
    }
  })

  it('is named nowhere in central\'s source, the `Env` docs included', () => {
    const files = Object.entries(sources)
    expect(files.length).toBeGreaterThan(50)
    expect(files.filter(([, text]) => OLD_PATTERN.test(text)).map(([path]) => path)).toEqual([])
  })

  it('is named nowhere in the example config or the sync-pipeline docs', () => {
    expect(OLD_PATTERN.test(exampleConfigRaw)).toBe(false)
    expect(OLD_PATTERN.test(syncPipelineRaw)).toBe(false)
  })
})
