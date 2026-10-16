import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MentionSuggestions } from './MentionSuggestions'

// A person with no name (never set, or cleared under #233) shows by email in
// the @-mention suggestions, and mentioning them inserts the email as the label.

const named = { id: 'u1', name: 'Named Person', email: 'named@example.com', title: null, type: 'user' as const }
const cleared = { id: 'u2', name: '', email: 'cleared@example.com', title: 'Analyst', type: 'user' as const }

// jsdom has no scrollIntoView; the component scrolls the highlighted option.
beforeAll(() => { Element.prototype.scrollIntoView = vi.fn() })

describe('MentionSuggestions, person with no name', () => {
  it('lists the person by email, with their title', () => {
    render(<MentionSuggestions items={[named, cleared]} command={() => {}} />)
    const option = screen.getByRole('button', { name: /cleared@example\.com/ })
    expect(option).toHaveTextContent('cleared@example.comAnalyst')
    expect(screen.getByRole('button', { name: /Named Person/ })).toBeInTheDocument()
  })

  it('inserts the email as the mention label when clicked', async () => {
    const command = vi.fn()
    render(<MentionSuggestions items={[named, cleared]} command={command} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /cleared@example\.com/ }))
    expect(command).toHaveBeenCalledWith({ id: 'user:u2', label: 'cleared@example.com' })
  })

  it('renders no blank option for the person', () => {
    render(<MentionSuggestions items={[cleared]} command={() => {}} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent?.trim()).not.toBe('')
  })
})

describe('MentionSuggestions, @admins', () => {
  it('lists @admins with how many admins it reaches and inserts the admins token when clicked', async () => {
    const command = vi.fn()
    const admins = { id: 'all' as const, memberCount: 2, type: 'admins' as const }
    render(<MentionSuggestions items={[admins, named]} command={command} />)
    const option = screen.getByRole('button', { name: /admins/ })
    expect(option).toHaveTextContent('2 members')
    await userEvent.setup().click(option)
    expect(command).toHaveBeenCalledWith({ id: 'admins:all', label: 'admins' })
  })
})

describe('MentionSuggestions, matched by email', () => {
  const byEmail = { id: 'u3', name: 'Jordan Lee', email: 'jdoe@example.org', title: null, type: 'user' as const, matchedByEmail: true }

  it('shows the address on a person who matched by email', () => {
    render(<MentionSuggestions items={[byEmail]} command={() => {}} />)
    expect(screen.getByRole('button', { name: /Jordan Lee/ })).toHaveTextContent('Jordan Leejdoe@example.org')
  })

  it('keeps the address hidden on a person who matched by name', () => {
    render(<MentionSuggestions items={[named]} command={() => {}} />)
    expect(screen.getByRole('button', { name: /Named Person/ })).not.toHaveTextContent('named@example.com')
  })

  it('still inserts the name as the mention label', async () => {
    const command = vi.fn()
    render(<MentionSuggestions items={[byEmail]} command={command} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /Jordan Lee/ }))
    expect(command).toHaveBeenCalledWith({ id: 'user:u3', label: 'Jordan Lee' })
  })
})
