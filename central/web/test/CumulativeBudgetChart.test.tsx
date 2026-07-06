import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CumulativeBudgetChart } from '../src/components/CumulativeBudgetChart'

describe('CumulativeBudgetChart', () => {
  it('renders without crashing with points', () => {
    const points = [
      { date: '2026-06-01', actual: 100, budget: 1000 },
      { date: '2026-06-02', actual: 250, budget: 2000 },
    ]
    render(<CumulativeBudgetChart points={points} label="API calls" />)
  })

  it('renders without crashing with empty points', () => {
    render(<CumulativeBudgetChart points={[]} />)
  })

  it('renders without crashing with null actual values', () => {
    const points = [
      { date: '2026-06-01', actual: null, budget: 100 },
      { date: '2026-06-02', actual: 50, budget: 200 },
    ]
    render(<CumulativeBudgetChart points={points} />)
  })
})
