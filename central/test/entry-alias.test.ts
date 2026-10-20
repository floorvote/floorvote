// Central's entry file has a provider-neutral name, src/index.ts (#393). The
// LegiScan-named src/index-legiscan.ts stays as a re-export, so a self-hoster's
// central/wrangler.toml that names it deploys the same worker.
import { describe, expect, it } from 'vitest'
import * as neutral from '../src/index'
import * as legacy from '../src/index-legiscan'

describe('central entry files', () => {
  it('exports the worker, its entrypoints, and the app from src/index.ts', () => {
    expect(Object.keys(neutral)).toEqual(expect.arrayContaining(['default', 'app', 'TenantApi', 'StatsApi']))
  })

  it('exports exactly the same objects from src/index-legiscan.ts', () => {
    expect(Object.keys(legacy).sort()).toEqual(Object.keys(neutral).sort())
    for (const [name, value] of Object.entries(neutral)) {
      expect(legacy[name as keyof typeof legacy], name).toBe(value)
    }
  })
})
