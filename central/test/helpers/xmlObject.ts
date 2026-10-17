import type { XmlNode } from '../../src/providers/govinfo/xml'

/**
 * A parsed XML file as a plain object, for the field inventory check
 * (test/helpers/fieldInventory.ts), which reads a feed's fields by path. A
 * child element becomes a key. The names a Bill Status file repeats for a list
 * (`item`, `summary`, `amendment`, `committeeReport`, `link`, `recordedVote`, and a
 * roll call file's `member`, `recorded-vote`, and `totals-by-party`)
 * always become arrays, so a path doesn't change with how many a file has. An
 * element with text and no children is its text.
 */
const LISTS = new Set(['item', 'summary', 'amendment', 'committeeReport', 'link', 'recordedVote', 'member', 'recorded-vote', 'totals-by-party'])

export function xmlObject(node: XmlNode): unknown {
  if (node.children.length === 0) return node.text.trim()
  const out: Record<string, unknown> = {}
  for (const child of node.children) {
    const value = xmlObject(child)
    if (LISTS.has(child.name)) ((out[child.name] ??= []) as unknown[]).push(value)
    else out[child.name] = value
  }
  return out
}
