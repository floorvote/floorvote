import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { SubjectsTrigger, SubjectsPanel } from './SubjectsDisclosure'

const SUBJECTS = ['Election Law', 'Election Administration', 'Referenda']

// The real call site (BillDetail) hoists `open` state and renders the trigger and
// panel in different parents. This harness reproduces that split so the tests
// exercise the components the way they're actually used.
function Harness({
  subjects,
  state,
  defaultOpen,
  onSubjectClick,
}: {
  subjects: string[]
  state: string
  defaultOpen: boolean
  onSubjectClick: (name: string) => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  if (subjects.length === 0) return null
  return (
    <>
      <SubjectsTrigger
        count={subjects.length}
        state={state}
        open={open}
        panelId="subjects-panel"
        onToggle={() => setOpen(o => !o)}
      />
      <SubjectsPanel
        id="subjects-panel"
        subjects={subjects}
        open={open}
        onSubjectClick={onSubjectClick}
      />
    </>
  )
}

describe('SubjectsDisclosure', () => {
  it('renders nothing when there are no subjects', () => {
    const { container } = render(
      <Harness subjects={[]} state="IL" defaultOpen={false} onSubjectClick={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the count in the trigger and hides the panel when closed', () => {
    render(
      <Harness subjects={SUBJECTS} state="UT" defaultOpen={false} onSubjectClick={vi.fn()} />,
    )
    const trigger = screen.getByRole('button', { name: /subjects/i })
    expect(trigger).toHaveTextContent('3')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Referenda')).not.toBeInTheDocument()
  })

  it('opens on click and reveals every subject', async () => {
    render(
      <Harness subjects={SUBJECTS} state="UT" defaultOpen={false} onSubjectClick={vi.fn()} />,
    )
    await userEvent.click(screen.getByRole('button', { name: /subjects/i }))
    expect(screen.getByRole('button', { name: /subjects/i })).toHaveAttribute('aria-expanded', 'true')
    for (const s of SUBJECTS) expect(screen.getByText(s)).toBeInTheDocument()
  })

  it('starts open when defaultOpen is set', () => {
    render(
      <Harness subjects={SUBJECTS} state="UT" defaultOpen onSubjectClick={vi.fn()} />,
    )
    expect(screen.getByText('Referenda')).toBeInTheDocument()
  })

  it('calls onSubjectClick with the bare subject name', async () => {
    const onSubjectClick = vi.fn()
    render(
      <Harness subjects={SUBJECTS} state="UT" defaultOpen onSubjectClick={onSubjectClick} />,
    )
    await userEvent.click(screen.getByText('Referenda'))
    expect(onSubjectClick).toHaveBeenCalledWith('Referenda')
  })

  it('names the source in the trigger tooltip', () => {
    render(
      <Harness subjects={SUBJECTS} state="UT" defaultOpen={false} onSubjectClick={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: /subjects/i }))
      .toHaveAttribute('aria-describedby', expect.any(String))
    expect(screen.getByText(/assigned by the legislature/i)).toBeInTheDocument()
  })
})
