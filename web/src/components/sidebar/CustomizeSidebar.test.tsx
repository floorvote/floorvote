import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CustomizeSidebarPanel } from './CustomizeSidebar'
import * as api from '../../lib/api'

describe('CustomizeSidebarPanel', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('lists toggleable widgets by name, with no redundant kind chip', () => {
    render(<CustomizeSidebarPanel modules={{}} onSaved={vi.fn()} />)
    expect(screen.getByText('Prioritized bills')).toBeInTheDocument()
    expect(screen.getByText('Upcoming hearings')).toBeInTheDocument()
    // The panel filters MODULES to type === 'widget', so every row was labelled
    // "Widget" and the per-row chip carried no information. Asserting its
    // absence keeps it from creeping back in.
    expect(screen.queryByText('Widget')).not.toBeInTheDocument()
  })

  it('shows the fixed-behavior hint instead of any hearings settings controls', () => {
    render(
      <CustomizeSidebarPanel
        modules={{ 'upcoming-hearings': { enabled: true, settings: {} } }}
        onSaved={vi.fn()}
      />,
    )
    expect(screen.getByText('Show hearings for prioritized bills in the next 30 days.')).toBeInTheDocument()
    // The old configurable controls are gone.
    expect(screen.queryByText('Show upcoming hearings for')).not.toBeInTheDocument()
    expect(screen.queryByText('In the next')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('toggling a widget PUTs the updated modules config', async () => {
    const spy = vi.spyOn(api, 'apiFetch').mockResolvedValue({} as never)
    const onSaved = vi.fn()
    render(<CustomizeSidebarPanel modules={{}} onSaved={onSaved} />)
    fireEvent.click(screen.getByRole('switch', { name: /Toggle Prioritized bills/i }))
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        '/admin/config',
        expect.objectContaining({ method: 'PUT' }),
      ),
    )
    expect(onSaved).toHaveBeenCalled()
  })
})
