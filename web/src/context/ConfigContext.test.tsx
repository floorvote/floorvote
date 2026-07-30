import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConfigContext, ConfigProvider, useMultiState, type AppConfig } from './ConfigContext'

vi.mock('../lib/api', () => ({ apiFetch: vi.fn(async () => ({ states: ['*'], multiState: true })) }))

function Probe() {
  return <div>multiState:{String(useMultiState())}</div>
}
function wrap(states: string[]) {
  const value = { config: { states } as AppConfig, multiState: states.length > 1, loading: false }
  return render(<ConfigContext.Provider value={value}><Probe /></ConfigContext.Provider>)
}

describe('useMultiState', () => {
  it('is false for a single state', () => {
    wrap(['RI'])
    expect(screen.getByText('multiState:false')).toBeInTheDocument()
  })
  it('is true for multiple states', () => {
    wrap(['RI', 'NJ'])
    expect(screen.getByText('multiState:true')).toBeInTheDocument()
  })
})

describe('ConfigProvider', () => {
  it('exposes multiState from the backend flag, not states.length', async () => {
    // Backend returns states:['*'] (length 1) but multiState:true — the provider
    // must honor the flag, not re-derive from the list length.
    render(<ConfigProvider><Probe /></ConfigProvider>)
    expect(await screen.findByText('multiState:true')).toBeInTheDocument()
  })
})
