/**
 * Lightweight markdown renderer for AI-generated bill summaries.
 * Handles the realistic output space: paragraphs, bullet/numbered lists,
 * bold, italic, inline code. No external dependencies.
 */

import React from 'react'
import { color, radius } from '../styles/tokens'
import { isHtml, htmlToMarkdown, normalizeInlineBullets, stripMarkdown } from '../lib/markdown'

// Re-exported for existing importers (BillList, BillHoverTooltip).
export { stripMarkdown }

interface Props {
  children: string
  fontSize?: number | string
  color?: string
  lineHeight?: number | string
  fontFamily?: string
}

// Render inline markdown: **bold**, *italic*, _italic_, `code`
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  // Combined pattern for bold, italic, and inline code
  const pattern = /(\*\*|__)(.*?)\1|(\*|_)(.*?)\3|`([^`]+)`/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[1]) {
      // bold
      parts.push(<strong key={key++}>{match[2]}</strong>)
    } else if (match[3]) {
      // italic
      parts.push(<em key={key++}>{match[4]}</em>)
    } else if (match[5] !== undefined) {
      // inline code
      parts.push(
        <code key={key++} style={{ fontFamily: 'monospace', fontSize: '0.9em', background: color.surfaceMuted, borderRadius: radius.sm, padding: '1px 4px' }}>
          {match[5]}
        </code>
      )
    }
    last = match.index + match[0].length
  }

  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export function MarkdownSummary({ children, fontSize, color: textColor = color.textSlate, lineHeight = 1.5, fontFamily = "'Source Serif 4', serif" }: Props) {
  const baseStyle: React.CSSProperties = { fontSize, color: textColor, lineHeight, fontFamily }
  const pStyle: React.CSSProperties = { ...baseStyle, margin: 0 }
  const listStyle: React.CSSProperties = { ...baseStyle, margin: '0 0 0 18px', padding: 0 }
  const liStyle: React.CSSProperties = { margin: '2px 0' }

  // Normalize HTML input (Gemini sometimes returns <ul><li>... instead of markdown)
  const rawInput = children.trim()
  const mdInput = isHtml(rawInput) ? htmlToMarkdown(rawInput) : rawInput

  // Split into blocks by blank lines
  const blocks = normalizeInlineBullets(mdInput).split(/\n{2,}/)

  const elements: React.ReactNode[] = []

  blocks.forEach((block, bi) => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length === 0) return

    const isUnordered = lines.every(l => /^[-*+]\s/.test(l))
    const isOrdered   = lines.every(l => /^\d+\.\s/.test(l))

    if (isUnordered) {
      elements.push(
        <ul key={bi} style={listStyle}>
          {lines.map((l, i) => (
            <li key={i} style={liStyle}>{renderInline(l.replace(/^[-*+]\s+/, ''))}</li>
          ))}
        </ul>
      )
    } else if (isOrdered) {
      elements.push(
        <ol key={bi} style={listStyle}>
          {lines.map((l, i) => (
            <li key={i} style={liStyle}>{renderInline(l.replace(/^\d+\.\s+/, ''))}</li>
          ))}
        </ol>
      )
    } else {
      // Mixed block: paragraph lines followed by list items.
      // Split into contiguous runs of paragraph vs list lines.
      const isBullet = (l: string) => /^[-*+]\s/.test(l) || /^\d+\.\s/.test(l)
      const firstBulletIdx = lines.findIndex(isBullet)

      if (firstBulletIdx > 0 && lines.slice(firstBulletIdx).every(isBullet)) {
        const paraLines = lines.slice(0, firstBulletIdx)
        const listLines = lines.slice(firstBulletIdx)
        const isOl = listLines.every(l => /^\d+\.\s/.test(l))

        elements.push(
          <p key={`${bi}-p`} style={pStyle}>{renderInline(paraLines.join(' '))}</p>
        )
        if (isOl) {
          elements.push(
            <ol key={`${bi}-l`} style={listStyle}>
              {listLines.map((l, i) => (
                <li key={i} style={liStyle}>{renderInline(l.replace(/^\d+\.\s+/, ''))}</li>
              ))}
            </ol>
          )
        } else {
          elements.push(
            <ul key={`${bi}-l`} style={listStyle}>
              {listLines.map((l, i) => (
                <li key={i} style={liStyle}>{renderInline(l.replace(/^[-*+]\s+/, ''))}</li>
              ))}
            </ul>
          )
        }
      } else {
        elements.push(
          <p key={bi} style={pStyle}>{renderInline(lines.join(' '))}</p>
        )
      }
    }
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {elements}
    </div>
  )
}
