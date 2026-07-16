import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { OperatorBranding } from './OperatorBranding'

const full = { name: 'Example Org', url: 'https://example.org/elections', contactEmails: ['ops@example.org'] }

describe('OperatorBranding', () => {
  it('shows logo + name in the operator link once the logo loads', () => {
    render(<OperatorBranding operator={full} />)
    const img = screen.getByAltText('Example Org')
    fireEvent.load(img)
    const link = screen.getByRole('link', { name: /Example Org/i })
    expect(link).toHaveAttribute('href', 'https://example.org/elections')
    expect(screen.getByText('Example Org')).toBeInTheDocument()
    expect(img).toBeVisible()
  })

  it('renders the credit unlinked when url is empty', () => {
    render(<OperatorBranding operator={{ ...full, url: '' }} />)
    fireEvent.load(screen.getByAltText('Example Org'))
    expect(screen.queryByRole('link', { name: /Example Org/i })).toBeNull()
    expect(screen.getByText('Example Org')).toBeInTheDocument()
  })

  it('keeps the name and drops the img when the logo fails to load', () => {
    render(<OperatorBranding operator={full} />)
    fireEvent.error(screen.getByAltText('Example Org'))
    expect(screen.queryByAltText('Example Org')).toBeNull()
    expect(screen.getByText('Example Org')).toBeInTheDocument()
  })

  it('collapses the credit entirely when the logo fails and there is no name', () => {
    render(<OperatorBranding operator={{ name: '', url: '', contactEmails: [] }} />)
    fireEvent.error(screen.getByAltText('FloorVote')) // alt falls back to PRODUCT_NAME
    expect(screen.queryByAltText('FloorVote')).toBeNull()
    expect(screen.queryByRole('link', { name: /FloorVote/i })).toBeNull()
    expect(screen.getByRole('link', { name: 'LegiScan' })).toBeInTheDocument()
  })

  it('always renders the LegiScan / CC BY data attribution', () => {
    render(<OperatorBranding operator={{ name: '', url: '', contactEmails: [] }} />)
    expect(screen.getByRole('link', { name: 'LegiScan' })).toHaveAttribute('href', 'https://legiscan.com')
    expect(screen.getByRole('link', { name: 'CC BY 4.0' })).toBeInTheDocument()
  })

  it('hides the AGPLv3 source link when no source URL is configured (private repo)', () => {
    render(<OperatorBranding operator={full} sourceUrl="" />)
    expect(screen.queryByRole('link', { name: /Source \(AGPLv3\)/i })).toBeNull()
  })

  it('renders the AGPLv3 source link when a source URL is configured (public repo)', () => {
    render(<OperatorBranding operator={full} sourceUrl="https://github.com/floorvote/floorvote" />)
    const link = screen.getByRole('link', { name: /Source \(AGPLv3\)/i })
    expect(link).toHaveAttribute('href', 'https://github.com/floorvote/floorvote')
  })
})
