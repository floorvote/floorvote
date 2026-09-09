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

  // Indent depth of a list line. Models emit two spaces per level (occasionally
  // a tab), so bucket spaces by two and count a tab as one level. Anything that
  // is not a list line has no depth -- prose is never a child of a bullet.
  const indentDepth = (raw: string): number => {
    const lead = /^[ \t]*/.exec(raw)?.[0] ?? ''
    const tabs = (lead.match(/\t/g) ?? []).length
    return tabs + Math.floor((lead.length - tabs) / 2)
  }
  const bulletPattern = /^([-*+]|\d+\.)\s+/
  const isBullet = (l: string) => bulletPattern.test(l.trim())

  type Item = { text: string; ordered: boolean; children: Item[] }

  // Build a tree from (depth, text) pairs. Depth is clamped to one level deeper
  // than the current stack so a jump from depth 0 to depth 3 -- which markdown
  // allows and models sometimes emit -- nests one level instead of creating
  // empty phantom lists.
  function buildItems(entries: { depth: number; line: string }[]): Item[] {
    const roots: Item[] = []
    const stack: Item[] = []
    for (const { depth, line } of entries) {
      const trimmed = line.trim()
      const marker = bulletPattern.exec(trimmed)?.[1] ?? '-'
      const item: Item = {
        text: trimmed.replace(bulletPattern, ''),
        ordered: /^\d+\.$/.test(marker),
        children: [],
      }
      const level = Math.min(depth, stack.length)
      stack.length = level
      if (level === 0) roots.push(item)
      else stack[level - 1].children.push(item)
      stack.push(item)
    }
    return roots
  }

  // A list is ordered only when every item at THAT level is numbered, so a level
  // mixing "1." and "-" renders as bullets rather than silently renumbering.
  function renderItems(items: Item[], key: string): React.ReactNode {
    const ordered = items.every(i => i.ordered)
    const children = items.map((item, i) => (
      <li key={i} style={liStyle}>
        {renderInline(item.text)}
        {item.children.length > 0 ? renderItems(item.children, `${key}-${i}`) : null}
      </li>
    ))
    return ordered
      ? <ol key={key} style={listStyle}>{children}</ol>
      : <ul key={key} style={listStyle}>{children}</ul>
  }

  blocks.forEach((block, bi) => {
    // Raw lines are kept: trimming here is what previously discarded indentation
    // and flattened every nested list into its parent.
    const rawLines = block.split('\n').filter(l => l.trim())
    if (rawLines.length === 0) return

    // Split into contiguous runs of prose and list lines, emitting each in turn.
    // A run of list lines carries its own indentation and becomes one tree.
    type Run = { bullet: boolean; lines: string[] }
    const runs: Run[] = []
    for (const line of rawLines) {
      const bullet = isBullet(line)
      const last = runs[runs.length - 1]
      if (last && last.bullet === bullet) last.lines.push(line)
      else runs.push({ bullet, lines: [line] })
    }

    runs.forEach((run, ri) => {
      const key = `${bi}-${ri}`
      if (!run.bullet) {
        elements.push(
          <p key={key} style={pStyle}>{renderInline(run.lines.map(l => l.trim()).join(' '))}</p>
        )
        return
      }
      const entries = run.lines.map(line => ({ depth: indentDepth(line), line }))
      elements.push(renderItems(buildItems(entries), key))
    })
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {elements}
    </div>
  )
}
