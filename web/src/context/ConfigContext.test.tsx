import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConfigContext, useMultiState, type AppConfig } from './ConfigContext'

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
