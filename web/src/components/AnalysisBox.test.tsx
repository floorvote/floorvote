import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AnalysisBox, AnalysisProgressChip, DIMMED_WHILE_RUNNING } from './AnalysisBox'

describe('AnalysisBox', () => {
  it('animates the stripes only while running', () => {
    const { container, rerender } = render(<AnalysisBox running={false} hatched>body</AnalysisBox>)
    expect(container.querySelector('.analyzing-box__stripes')).toBeTruthy()
    expect(container.querySelector('.analyzing-box__stripes--animated')).toBeNull()

    rerender(<AnalysisBox running hatched>body</AnalysisBox>)
    expect(container.querySelector('.analyzing-box__stripes--animated')).toBeTruthy()
  })

  it('omits the stripe layer entirely at rest when not hatched', () => {
    const { container } = render(<AnalysisBox running={false}>body</AnalysisBox>)
    expect(container.querySelector('.analyzing-box__stripes')).toBeNull()
  })

  it('adds the stripe layer to an unhatched box once it starts running', () => {
    const { container } = render(<AnalysisBox running>body</AnalysisBox>)
    expect(container.querySelector('.analyzing-box__stripes--animated')).toBeTruthy()
  })

  it('renders the error as an alert inside the box', () => {
    render(<AnalysisBox running={false} error="Something broke">body</AnalysisBox>)
    expect(screen.getByRole('alert')).toHaveTextContent('Something broke')
  })

  it('renders no alert when there is no error', () => {
    render(<AnalysisBox running={false}>body</AnalysisBox>)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders a notice as a status, not an alert', () => {
    render(<AnalysisBox running={false} notice="Re-analyzed S1713.">body</AnalysisBox>)
    expect(screen.getByRole('status')).toHaveTextContent('Re-analyzed S1713.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows an error instead of a notice when both are set', () => {
    render(<AnalysisBox running={false} error="Broke" notice="Re-analyzed S1713.">body</AnalysisBox>)
    expect(screen.getByRole('alert')).toHaveTextContent('Broke')
    expect(screen.queryByText('Re-analyzed S1713.')).toBeNull()
  })

  it('renders no status when there is no notice', () => {
    render(<AnalysisBox running={false}>body</AnalysisBox>)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders children', () => {
    render(<AnalysisBox running={false}><span>inner</span></AnalysisBox>)
    expect(screen.getByText('inner')).toBeInTheDocument()
  })
})

describe('AnalysisProgressChip', () => {
  it('renders the label with a spinning icon', () => {
    const { container } = render(<AnalysisProgressChip label="Analyzing…" />)
    expect(screen.getByText('Analyzing…')).toBeInTheDocument()
    expect(container.querySelector('.ai-progress-label__icon')).toBeTruthy()
  })

  it('announces progress politely for screen readers', () => {
    render(<AnalysisProgressChip label="Analyzing…" />)
    expect(screen.getByRole('status')).toHaveTextContent('Analyzing…')
  })
})

describe('DIMMED_WHILE_RUNNING', () => {
  it('is the shared 0.4 dim applied to stale content', () => {
    expect(DIMMED_WHILE_RUNNING).toEqual({ opacity: 0.4 })
  })
})
