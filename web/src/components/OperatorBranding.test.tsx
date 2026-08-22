import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { OperatorBranding } from './OperatorBranding'
import { SOURCE_URL, LICENSE_URL } from '../../../shared/brand'

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

  // Suppression drops the source *link*, never the license notice: AGPL §5 asks
  // that legal notices be preserved, so config can withhold a URL the operator
  // does not have but cannot silently strip the attribution.
  it('keeps the license notice but drops the link when the source URL is empty', () => {
    renderBranding(<OperatorBranding operator={full} sourceUrl="" />)
    expect(screen.queryByRole('link', { name: 'FloorVote' })).toBeNull()
    expect(screen.getByText(/AGPLv3/)).toBeInTheDocument()
    expect(screen.queryByText(/^Source:/)).toBeNull()
  })

  it('renders Source: <product> (AGPLv3) with the repo link when configured', () => {
    renderBranding(<OperatorBranding operator={full} sourceUrl="https://github.com/floorvote/floorvote" />)
    expect(screen.getByRole('link', { name: 'FloorVote' }))
      .toHaveAttribute('href', 'https://github.com/floorvote/floorvote')
    expect(screen.getByText(/Source:/)).toBeInTheDocument()
  })

  // The license link used to be built as `${sourceUrl}/blob/main/LICENSE` — GitHub's
  // URL shape with a `main` default branch, which 404s the moment an operator points
  // the source anywhere else. The license text lives at a canonical, invariant
  // address instead, because AGPLv3 is a property of the work, not of the operator.
  it('links the license to its canonical address, never one derived from the source', () => {
    renderBranding(<OperatorBranding operator={full} sourceUrl="https://gitlab.com/org/fork" />)
    expect(screen.getByRole('link', { name: 'AGPLv3' })).toHaveAttribute('href', LICENSE_URL)
    expect(LICENSE_URL).toContain('gnu.org')
    for (const a of screen.getAllByRole('link')) {
      expect(a.getAttribute('href')).not.toContain('blob/main/LICENSE')
    }
  })

  // The license link is invariant, so it survives suppression of the source link.
  it('keeps the license link even when the source URL is suppressed', () => {
    renderBranding(<OperatorBranding operator={full} sourceUrl="" />)
    expect(screen.getByRole('link', { name: 'AGPLv3' })).toHaveAttribute('href', LICENSE_URL)
  })

  // Precedence: explicit prop → operator config → the built-in constant. The
  // constant is the truthful default for an unmodified deployment; an operator
  // running modified code overrides it with their own published source.
  it('prefers the operator config source URL over the built-in constant', () => {
    renderBranding(<OperatorBranding operator={{ ...full, sourceUrl: 'https://gitea.example/org/fork' }} />)
    expect(screen.getByRole('link', { name: 'FloorVote' }))
      .toHaveAttribute('href', 'https://gitea.example/org/fork')
  })

  it('treats an explicitly empty operator config URL as suppression, not as unset', () => {
    renderBranding(<OperatorBranding operator={{ ...full, sourceUrl: '' }} />)
    expect(screen.queryByRole('link', { name: 'FloorVote' })).toBeNull()
    expect(screen.getByText(/AGPLv3/)).toBeInTheDocument()
  })

  it('names the operator in the tooltip so the user knows who owes them the source', async () => {
    renderBranding(<OperatorBranding operator={full} />)
    fireEvent.click(screen.getByRole('button', { name: /license/i }))
    expect(await screen.findByText(/Operated by Example Org/)).toBeInTheDocument()
    expect(screen.getByText(/entitles you to the source code/i)).toBeInTheDocument()
  })

  it('drops the operator clause when no name is configured', async () => {
    renderBranding(<OperatorBranding operator={{ ...full, name: '' }} />)
    fireEvent.click(screen.getByRole('button', { name: /license/i }))
    expect(await screen.findByText(/entitles you to the source code/i)).toBeInTheDocument()
    expect(screen.queryByText(/Operated by/)).toBeNull()
  })

  // With a working link the link IS the offer, so the recourse is framed as a
  // fallback for when it fails — not as an instruction to ask for what is already
  // one click away. With no link there is nothing to fall back from, so it asks.
  it('frames the contact as a fallback when a source link is present', async () => {
    renderBranding(<OperatorBranding operator={full} />)
    fireEvent.click(screen.getByRole('button', { name: /license/i }))
    expect(await screen.findByText(/if that link/i)).toBeInTheDocument()
    expect(screen.queryByText(/^To request it/)).toBeNull()
  })

  it('asks for the source outright when no link is offered', async () => {
    renderBranding(<OperatorBranding operator={{ ...full, sourceUrl: '' }} />)
    fireEvent.click(screen.getByRole('button', { name: /license/i }))
    expect(await screen.findByText(/to request it/i)).toBeInTheDocument()
    expect(screen.queryByText(/if that link/i)).toBeNull()
  })

  it('makes the contact email a mailto link, not plain text', async () => {
    renderBranding(<OperatorBranding operator={full} />)
    fireEvent.click(screen.getByRole('button', { name: /license/i }))
    expect(await screen.findByRole('link', { name: /ops@example\.org/ }))
      .toHaveAttribute('href', 'mailto:ops@example.org')
  })

  // Feedback first when it is wired: one click beats composing an email. The
  // callback's presence is the availability signal — Sidebar withholds it in demo
  // mode, where the feedback button does not exist and POST /feedback is refused.
  it('offers the feedback box when wired, with the email alongside it', async () => {
    const onOpenFeedback = vi.fn()
    renderBranding(<OperatorBranding operator={full} onOpenFeedback={onOpenFeedback} />)
    fireEvent.click(screen.getByRole('button', { name: /license/i }))
    // Both routes offered side by side; assert before acting, because acting
    // dismisses the bubble — the feedback dialog takes over from here.
    const request = await screen.findByRole('button', { name: /send a request/i })
    expect(screen.getByRole('link', { name: /ops@example\.org/ })).toBeInTheDocument()
    fireEvent.click(request)
    expect(onOpenFeedback).toHaveBeenCalledOnce()
  })

  it('falls back to the email alone when feedback is unavailable', async () => {
    renderBranding(<OperatorBranding operator={full} />)
    fireEvent.click(screen.getByRole('button', { name: /license/i }))
    expect(await screen.findByRole('link', { name: /ops@example\.org/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send a request/i })).toBeNull()
  })

  it('omits the recourse clause entirely when there is no contact and no feedback', async () => {
    renderBranding(<OperatorBranding operator={{ ...full, contactEmails: [] }} />)
    fireEvent.click(screen.getByRole('button', { name: /license/i }))
    expect(await screen.findByText(/entitles you to the source code/i)).toBeInTheDocument()
    expect(screen.queryByText(/if that link/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /send a request/i })).toBeNull()
  })

  // Guards the SOURCE_URL constant itself: every other source-line case passes
  // `sourceUrl` explicitly, so the suite stayed green while the constant was empty
  // and the footer shipped with no AGPLv3 §13 source offer.
  it('renders the source line from the SOURCE_URL default when no prop is given', () => {
    renderBranding(<OperatorBranding operator={full} />)
    expect(screen.getByRole('link', { name: 'FloorVote' })).toHaveAttribute('href', SOURCE_URL)
    expect(SOURCE_URL).toMatch(/^https:\/\/\S+[^/]$/)
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
