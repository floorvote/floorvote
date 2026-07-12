import { describe, it } from 'vitest'
import { render } from '@testing-library/react'
import { DailyCostChart } from '../src/components/DailyCostChart'

describe('DailyCostChart', () => {
  it('renders without crashing with points', () => {
    const points = [
      { date: '2026-06-01', value: 0.12 },
      { date: '2026-06-02', value: 0.34 },
    ]
    render(<DailyCostChart points={points} label="Spend" valueFormat={n => `$${n.toFixed(2)}`} />)
  })

  it('renders without crashing with empty points', () => {
    render(<DailyCostChart points={[]} />)
  })
})
