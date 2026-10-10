import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LegislativeHistory } from './LegislativeHistory'

const HEARING_VIDEO = 'http://video.oct.dc.gov/VOD/DCC/2025_11/11_13_25_Youth_Judici.html'

function renderHistory(entries: { date: string; action: string; chamber: string; videoUrl?: string }[]) {
  render(<LegislativeHistory entries={entries} votes={[]} lastAction={entries[entries.length - 1].action}
    lastActionDate={entries[entries.length - 1].date} defaultOpen hideHeader />)
}

describe('meeting videos in the legislative history', () => {
  it('link from the entry they record, in a new tab', () => {
    renderHistory([
      { date: '2025-10-06', action: 'B26-0400 Introduced', chamber: 'C' },
      { date: '2025-11-13', action: 'Public Hearing on B26-0400', chamber: 'C', videoUrl: HEARING_VIDEO },
    ])
    const links = screen.getAllByRole('link', { name: /^Video:/ })
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAccessibleName('Video: Public Hearing on B26-0400 (opens in a new tab)')
    expect(links[0]).toHaveAttribute('href', HEARING_VIDEO)
    expect(links[0]).toHaveAttribute('target', '_blank')
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('never link anything but an http(s) URL', () => {
    renderHistory([{ date: '2025-11-13', action: 'Public Hearing on B26-0400', chamber: 'C', videoUrl: 'javascript:alert(1)' }])
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
