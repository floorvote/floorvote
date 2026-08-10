import { describe, it, expect } from 'vitest'
import { formatProgress, formatProgressDone } from './progress'

describe('formatProgress', () => {
  it('rewrites in place on a TTY', () => {
    expect(formatProgress('Bills: 30/935', true)).toBe('\rBills: 30/935')
  })

  it('emits a complete line off a TTY', () => {
    expect(formatProgress('Bills: 30/935', false)).toBe('Bills: 30/935\n')
  })

  it('never leaves a redirected run without a line terminator', () => {
    // The whole point: `\r` alone means a piped/backgrounded seed shows nothing
    // until exit. Off a TTY every update must end in a newline.
    expect(formatProgress('x', false).endsWith('\n')).toBe(true)
    expect(formatProgress('x', false)).not.toContain('\r')
  })
})

describe('formatProgressDone', () => {
  it('overwrites the counter then breaks the line on a TTY', () => {
    expect(formatProgressDone('✓ 935 bills seeded', true)).toBe('\r✓ 935 bills seeded\n')
  })

  it('omits the stray carriage return off a TTY', () => {
    expect(formatProgressDone('✓ 935 bills seeded', false)).toBe('✓ 935 bills seeded\n')
  })
})
