import { Fragment, type CSSProperties } from 'react'
import { color, radius } from '../styles/tokens'

const codeStyle: CSSProperties = {
  fontFamily: 'monospace',
  fontSize: '0.9em',
  background: color.surfaceMuted,
  borderRadius: radius.sm,
  padding: '0 4px',
}

/**
 * Render helper/hint text with light inline formatting:
 * - `backtick`-delimited segments become monospace <code> chips
 * - newlines become line breaks
 * No HTML is interpreted; everything else is plain text.
 */
export function HintText({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <>
      {lines.map((line, li) => (
        <Fragment key={li}>
          {li > 0 && <br />}
          {line.split('`').map((seg, i) =>
            i % 2 === 1
              ? <code key={i} style={codeStyle}>{seg}</code>
              : <Fragment key={i}>{seg}</Fragment>,
          )}
        </Fragment>
      ))}
    </>
  )
}
