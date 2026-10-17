import { describe, it, expect } from 'vitest'
import { coverageCapabilities, stateCapabilities } from '../../src/lib/capabilities'

// Pinned expectations. Tenants receive each state's capabilities, shaped
// `{ bodyEvents, deadlines }`, from `stateCapabilities`. Changing what a
// provider can do should change that deliberately, so this fails until
// someone updates the expectation here.
const PINNED = {
  legiscan: { bodyEvents: false, deadlines: true },
  lims: { bodyEvents: true, deadlines: true },
  mga: { bodyEvents: false, deadlines: false },
  lis: { bodyEvents: false, deadlines: false },
} as const

describe('what tenants receive for a state', () => {
  const owned = (state: string, provider: string) => new Map([[state, provider]])

  it.each([['DC', 'lims'], ['MD', 'mga'], ['VA', 'lis'], ['TX', 'legiscan']])('has the shape { bodyEvents, deadlines } for %s on %s', (state, provider) => {
    const caps = stateCapabilities(owned(state, provider), state)
    expect(Object.keys(caps).sort()).toEqual(['bodyEvents', 'deadlines'])
    expect(caps).toEqual(PINNED[provider as keyof typeof PINNED])
  })

  it('sends only a state whose provider has body events or deadlines', () => {
    expect(coverageCapabilities(owned('DC', 'lims'), ['DC'])).toEqual({ DC: { bodyEvents: true, deadlines: true } })
    expect(coverageCapabilities(owned('MD', 'mga'), ['MD'])).toEqual({})
    expect(coverageCapabilities(owned('VA', 'lis'), ['VA'])).toEqual({})
    // A state without an ownership row falls back to LegiScan, which sends deadlines (calendar type 10).
    expect(coverageCapabilities(new Map(), ['TX'])).toEqual({ TX: { bodyEvents: false, deadlines: true } })
  })
})
