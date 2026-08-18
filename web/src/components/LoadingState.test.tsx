import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { LoadingState } from './LoadingState'
import { createProgressBox } from '../lib/retryFetch'

beforeEach(() => { vi.useFakeTimers() })
// Both in afterEach, not at the end of the test body: a failing assertion skips
// the rest of the body, and a leaked matchMedia stub would then follow the
// reduced-motion test into every later test.
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function advance(ms: number) {
  act(() => { vi.advanceTimersByTime(ms) })
}

describe('LoadingState escalation', () => {
  it('renders nothing for the first half-second', () => {
    const { container } = render(<LoadingState progress={createProgressBox()} />)
    advance(200)
    expect(container.textContent).toBe('')
    expect(screen.queryByRole('img', { name: 'Loading' })).toBeNull()
    // Past the first tick, so this pins the gate itself rather than just
    // "nothing has re-rendered yet" — at 300ms the component has re-rendered
    // with a real elapsed time and must still be showing nothing.
    advance(100)
    expect(container.textContent).toBe('')
    expect(screen.queryByRole('img', { name: 'Loading' })).toBeNull()
  })

  it('shows the spinner with no text at 500ms', () => {
    // Tasks 4-6 all pass onRetryNow, so the button has to be gated on the box
    // being populated rather than on the callback merely existing — otherwise
    // every ordinary half-second load grows a "Retry now".
    render(<LoadingState progress={createProgressBox()} onRetryNow={() => {}} />)
    advance(500)
    expect(screen.getByRole('img', { name: 'Loading' })).toBeInTheDocument()
    expect(screen.queryByText(/taking longer/i)).toBeNull()
    expect(screen.queryByText(/retrying/i)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('clears its tick on unmount', () => {
    const { unmount } = render(<LoadingState progress={createProgressBox()} />)
    advance(500)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sizes the spinner to the variant', () => {
    const { unmount } = render(<LoadingState variant="full" progress={createProgressBox()} />)
    advance(500)
    expect(screen.getByRole('img', { name: 'Loading' })).toHaveAttribute('width', '56')
    unmount()
    render(<LoadingState variant="bare" progress={createProgressBox()} />)
    advance(500)
    expect(screen.getByRole('img', { name: 'Loading' })).toHaveAttribute('width', '40')
  })

  it('adds "taking longer than usual" at 10s', () => {
    render(<LoadingState progress={createProgressBox()} />)
    // The tick either side of the threshold, so this pins 10s from both
    // directions rather than just "somewhere in (9s, 10.5s]".
    advance(9_750)
    expect(screen.queryByText(/taking longer than usual/i)).toBeNull()
    advance(250)
    expect(screen.getByText(/taking longer than usual/i)).toBeInTheDocument()
  })

  it('shows a countdown and a retry button once a retry is scheduled', () => {
    const progress = createProgressBox()
    progress.current = { attempt: 2, nextRetryAt: Date.now() + 4_000 }
    render(<LoadingState progress={progress} onRetryNow={() => {}} />)
    advance(500)
    expect(screen.getByText(/can't reach the server/i)).toBeInTheDocument()
    expect(screen.getByText(/4s/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry now/i })).toBeInTheDocument()
  })

  it('counts down, then drops the number once the attempt is in flight', () => {
    const progress = createProgressBox()
    progress.current = { attempt: 2, nextRetryAt: Date.now() + 4_000 }
    render(<LoadingState progress={progress} onRetryNow={() => {}} />)
    advance(500)
    expect(screen.getByText(/retrying in 4s/i)).toBeInTheDocument()
    advance(2_000)
    expect(screen.getByText(/retrying in 2s/i)).toBeInTheDocument()
    // Exactly on the deadline — the attempt is starting. This is the frame that
    // would read "0s…", and retryFetch deliberately leaves the box set for the
    // attempt's whole run, so that frame would then stick for up to 10s.
    advance(1_500)
    expect(screen.queryByText(/0s/)).toBeNull()
    expect(screen.getByText(/^retrying…$/i)).toBeInTheDocument()
    // And it stays wordless rather than counting into negative seconds.
    advance(3_000)
    expect(screen.queryByText(/\ds/)).toBeNull()
    expect(screen.getByText(/^retrying…$/i)).toBeInTheDocument()
  })

  it('skips the blank gate when a retry is already in flight', () => {
    // A parent remounting this mid-retry resets the elapsed clock; re-blanking
    // the screen when we already know the server is unreachable is a regression.
    const progress = createProgressBox()
    progress.current = { attempt: 3, nextRetryAt: Date.now() + 2_000 }
    render(<LoadingState progress={progress} />)
    expect(screen.getByText(/can't reach the server/i)).toBeInTheDocument()
    advance(100)
    expect(screen.getByText(/can't reach the server/i)).toBeInTheDocument()
  })

  it('keeps the ticking seconds out of the live region', () => {
    const progress = createProgressBox()
    progress.current = { attempt: 2, nextRetryAt: Date.now() + 4_000 }
    render(<LoadingState progress={progress} onRetryNow={() => {}} />)
    advance(500)
    const live = screen.getByText(/can't reach the server/i)
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.textContent).not.toMatch(/\ds/)
    // The region announces a whole sentence, not the front half of one.
    expect(live.textContent).not.toMatch(/retrying/i)
    expect(screen.getByText(/4s/).getAttribute('aria-hidden')).toBe('true')
    // Back in flow now that it has something to show. jsdom does no layout, so
    // this string is the only instrument available — and the whole defence
    // against the row being pinned out of flow and overlapping the spinner.
    expect((live.parentElement as HTMLElement).style.position).toBe('')
  })

  it('mounts the live region empty, before it has anything to announce', () => {
    // A live region inserted with its text already in it is unreliably
    // announced; it has to be in the DOM first and gain content later.
    const { container } = render(<LoadingState progress={createProgressBox()} />)
    advance(500)
    const live = container.querySelector('[aria-live="polite"]')
    expect(live).not.toBeNull()
    expect(live!.textContent).toBe('')
    // And it costs no layout while empty: out of flow means it is not a flex
    // item, so it cannot claim a `gap` under the wordmark for an empty row.
    expect((live!.parentElement as HTMLElement).style.position).toBe('absolute')
  })

  it('fires onRetryNow when the button is clicked', () => {
    const onRetryNow = vi.fn()
    const progress = createProgressBox()
    progress.current = { attempt: 2, nextRetryAt: Date.now() + 4_000 }
    render(<LoadingState progress={progress} onRetryNow={onRetryNow} />)
    advance(500)
    act(() => { screen.getByRole('button', { name: /retry now/i }).click() })
    expect(onRetryNow).toHaveBeenCalledOnce()
  })

  it('does not submit a surrounding form', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    const progress = createProgressBox()
    progress.current = { attempt: 2, nextRetryAt: Date.now() + 4_000 }
    render(
      <form onSubmit={onSubmit}>
        <LoadingState progress={progress} onRetryNow={() => {}} />
      </form>,
    )
    advance(500)
    act(() => { screen.getByRole('button', { name: /retry now/i }).click() })
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('LoadingState variants', () => {
  it('bare renders no wordmark', () => {
    render(<LoadingState variant="bare" progress={createProgressBox()} />)
    advance(500)
    expect(screen.queryByText('Floor')).toBeNull()
  })

  it('full sizes the splash to the visual viewport, not 100vh', () => {
    // The splash renders outside .app-layout, so it has to repeat that file's
    // dvh fix itself — 100vh overshoots the visual viewport on mobile and makes
    // the document scroll. See styles/mobile.css.
    const { container } = render(<LoadingState variant="full" progress={createProgressBox()} />)
    advance(500)
    expect((container.firstElementChild as HTMLElement).style.minHeight).toBe('100dvh')
  })

  it('full renders the wordmark', () => {
    render(<LoadingState variant="full" progress={createProgressBox()} />)
    advance(500)
    expect(screen.getByText('Floor')).toBeInTheDocument()
    expect(screen.getByText('Vote')).toBeInTheDocument()
  })
})

describe('reduced motion', () => {
  it('surfaces the first text tier at 1s, because the spinner is frozen', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('prefers-reduced-motion'),
      media: q, addEventListener() {}, removeEventListener() {},
    }))
    render(<LoadingState progress={createProgressBox()} />)
    advance(750)
    expect(screen.queryByText(/taking longer than usual/i)).toBeNull()
    advance(500)
    expect(screen.getByText(/taking longer than usual/i)).toBeInTheDocument()
  })
})
