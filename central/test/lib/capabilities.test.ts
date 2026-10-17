import { describe, it, expect } from 'vitest'
import { coverageCapabilities, stateCapabilities } from '../../src/lib/capabilities'

// Pinned expectations. Tenants receive each state's capabilities, shaped
// `{ bodyEvents, deadlines }` (plus `bodyName`, for a provider that publishes
// its legislature's own calendar), from `stateCapabilities`. Changing what a
// provider can do should change that deliberately, so this fails until
// someone updates the expectation here.
const PINNED = {
  legiscan: { bodyEvents: false, deadlines: false },
  lims: { bodyEvents: true, deadlines: true, bodyName: 'Council' },
  mga: { bodyEvents: false, deadlines: false },
  lis: { bodyEvents: false, deadlines: false },
} as const

describe('what tenants receive for a state', () => {
  const owned = (state: string, provider: string) => new Map([[state, provider]])

  it.each([['DC', 'lims'], ['MD', 'mga'], ['VA', 'lis'], ['TX', 'legiscan']])('has the capabilities shape for %s on %s', (state, provider) => {
    const caps = stateCapabilities(owned(state, provider), state)
    expect(Object.keys(caps).sort()).toEqual(provider === 'lims' ? ['bodyEvents', 'bodyName', 'deadlines'] : ['bodyEvents', 'deadlines'])
    expect(caps).toEqual(PINNED[provider as keyof typeof PINNED])
  })

  it('sends only a state whose provider has body events or deadlines', () => {
    expect(coverageCapabilities(owned('DC', 'lims'), ['DC'])).toEqual({ DC: { bodyEvents: true, deadlines: true, bodyName: 'Council' } })
    expect(coverageCapabilities(owned('MD', 'mga'), ['MD'])).toEqual({})
    expect(coverageCapabilities(owned('VA', 'lis'), ['VA'])).toEqual({})
    expect(coverageCapabilities(new Map(), ['TX'])).toEqual({})
  })
})
