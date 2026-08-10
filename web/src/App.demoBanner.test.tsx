import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// Regression pin: DemoBanner must render nothing when config.demoBanner is
// absent, even once demoMode has resolved true — so a future tenant never
// flashes another tenant's hardcoded fallback copy while GET /config is still
// in flight. No prior test caught this: App.layout.test.tsx never sets
// demoMode true, so it would pass even if a hardcoded fallback string were
// reintroduced into DemoBanner's `text` value.
const { demo } = vi.hoisted(() => ({ demo: { demoMode: true, demoLocked: false } }))
vi.mock('./context/DemoContext', () => ({ useDemo: () => demo }))

import { DemoBanner } from './App'
import { ConfigContext, type AppConfig } from './context/ConfigContext'

function renderBanner(config: Partial<AppConfig>) {
  const value = { config: config as AppConfig, multiState: false, loading: false }
  return render(<ConfigContext.Provider value={value}><DemoBanner /></ConfigContext.Provider>)
}

describe('DemoBanner', () => {
  it('renders nothing when demoMode is true but config.demoBanner is absent', () => {
    const { container } = renderBanner({ demoBanner: undefined })
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument()
  })

  it('renders the banner text and Dismiss button when demoMode is true and demoBanner is set', () => {
    renderBanner({ demoBanner: 'This is a demo.' })
    expect(screen.getByText('This is a demo.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument()
  })
})
