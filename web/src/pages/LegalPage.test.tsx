import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { LegalPage } from './LegalPage'

describe('LegalPage', () => {
  it('renders the markdown as sanitized HTML with a back link home', () => {
    render(
      <MemoryRouter>
        <LegalPage title="Terms of Use" content={'# Terms of Use\n\nHello **world**.'} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { name: 'Terms of Use' })).toBeInTheDocument()
    expect(screen.getByText('world')).toBeInTheDocument() // rendered inside <strong>
    expect(screen.getByRole('link', { name: /back to/i })).toHaveAttribute('href', '/')
  })
})
