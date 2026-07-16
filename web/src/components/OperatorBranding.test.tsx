import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { OperatorBranding } from './OperatorBranding'

const full = { name: 'Example Org', url: 'https://example.org/elections', contactEmails: ['ops@example.org'] }

function renderBranding(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

describe('OperatorBranding', () => {
  it('shows logo + name in the operator link once the logo loads', () => {
    renderBranding(<OperatorBranding operator={full} />)
    const img = screen.getByAltText('Example Org')
    fireEvent.load(img)
    const link = screen.getByRole('link', { name: /Example Org/i })
    expect(link).toHaveAttribute('href', 'https://example.org/elections')
    expect(screen.getByText('Example Org')).toBeInTheDocument()
    expect(img).toBeVisible()
  })

  it('renders the credit unlinked when url is empty', () => {
    renderBranding(<OperatorBranding operator={{ ...full, url: '' }} />)
    fireEvent.load(screen.getByAltText('Example Org'))
    expect(screen.queryByRole('link', { name: /Example Org/i })).toBeNull()
    expect(screen.getByText('Example Org')).toBeInTheDocument()
  })

  it('keeps the name and drops the img when the logo fails to load', () => {
    renderBranding(<OperatorBranding operator={full} />)
    fireEvent.error(screen.getByAltText('Example Org'))
    expect(screen.queryByAltText('Example Org')).toBeNull()
    expect(screen.getByText('Example Org')).toBeInTheDocument()
  })

  it('collapses the operator credit when the logo fails and there is no name', () => {
    renderBranding(<OperatorBranding operator={{ name: '', url: '', contactEmails: [] }} sourceUrl="" />)
    fireEvent.error(screen.getByAltText('FloorVote')) // alt falls back to PRODUCT_NAME
    expect(screen.queryByAltText('FloorVote')).toBeNull()
    // Credit collapsed: no operator link; the always-on Data attribution remains.
    expect(screen.getByRole('link', { name: 'LegiScan' })).toBeInTheDocument()
  })

  it('always renders the LegiScan / CC BY data attribution', () => {
    renderBranding(<OperatorBranding operator={{ name: '', url: '', contactEmails: [] }} />)
    expect(screen.getByRole('link', { name: 'LegiScan' })).toHaveAttribute('href', 'https://legiscan.com')
    expect(screen.getByRole('link', { name: 'CC BY 4.0' })).toBeInTheDocument()
  })

  it('hides the source line when no source URL is set (private repo)', () => {
    renderBranding(<OperatorBranding operator={full} sourceUrl="" />)
    expect(screen.queryByRole('link', { name: 'AGPLv3' })).toBeNull()
  })

  it('renders Source: <product> (AGPLv3) with repo + license links when configured', () => {
    renderBranding(<OperatorBranding operator={full} sourceUrl="https://github.com/floorvote/floorvote" />)
    expect(screen.getByRole('link', { name: 'FloorVote' }))
      .toHaveAttribute('href', 'https://github.com/floorvote/floorvote')
    expect(screen.getByRole('link', { name: 'AGPLv3' }))
      .toHaveAttribute('href', 'https://github.com/floorvote/floorvote/blob/main/LICENSE')
  })

  it('renders both legal links with a separator when both docs exist', () => {
    renderBranding(<OperatorBranding operator={full} showTerms showPrivacy />)
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
  })

  it('renders only the present legal link, no dangling separator', () => {
    renderBranding(<OperatorBranding operator={full} showTerms={false} showPrivacy />)
    expect(screen.queryByRole('link', { name: 'Terms' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Privacy' })).toBeInTheDocument()
  })

  it('renders no legal line when neither doc exists', () => {
    renderBranding(<OperatorBranding operator={full} showTerms={false} showPrivacy={false} />)
    expect(screen.queryByRole('link', { name: 'Terms' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Privacy' })).toBeNull()
  })
})
