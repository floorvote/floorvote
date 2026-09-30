// Scraped dccouncil.gov values reach <a href> on the People page only when they
// are Council links and plain emails (React neutralises javascript: but not data:).
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('../lib/api', () => ({
  ApiError: class extends Error {},
  apiFetch: vi.fn(async () => ({
    committees: [{
      slug: 'x', name: 'Committee on X', url: 'data:text/html,<script>alert(1)</script>',
      chair: { name: 'Evil Chair', url: 'javascript:alert(document.cookie)' },
      members: [{ name: 'Data Member', url: 'data:text/html,<script>alert(2)</script>' }],
      staff: [{ name: 'S', title: null, email: 'a@b.gov?cc=attacker@evil.test&body=hi', phone: '(202) 555-0100', url: null }],
      agencies: [],
    }],
    people: [], updatedAt: null,
  })),
}))

import { People } from './People'

describe('People: scraped links', () => {
  it('no scraped href is a script-capable scheme', async () => {
    render(<People />)
    await waitFor(() => expect(screen.getByText('Evil Chair')).toBeInTheDocument())
    const hrefs = [...document.querySelectorAll('a')].map(a => a.getAttribute('href') ?? '')
    expect(hrefs.filter(h => /^javascript:(?!throw new Error\('React has blocked)/i.test(h))).toEqual([])
    expect(hrefs.filter(h => /^data:/i.test(h))).toEqual([])
  })
})
