import type { FieldInventory, ProviderVocabulary } from '../../src/providers/sdk'

/**
 * The field inventory check for a provider's mapping test. Every field in a
 * recorded fixture must be in the provider's inventory (`FieldInventory`), so
 * a field the feed starts sending fails the test until someone decides to map
 * it, show it as an extra, or ignore it with a reason:
 *
 *   expect(inventoryProblems(recordInventory, fixtures, vocabulary)).toEqual([])
 *
 * Returns one line per problem, so a failure lists them all:
 * - a field the inventory doesn't list, with its path;
 * - an inventory entry naming an extra the vocabulary doesn't declare (when
 *   `vocabulary` is given).
 *
 * A field is any value that isn't an object or array: a string, number,
 * boolean, or null, so a field that is always null in the fixtures is still
 * checked. Paths are dotted from each fixture's root, with `[]` for an array's
 * items. A field is listed by its own path or by an ignored ancestor, and an
 * array of plain values (`Subjects[]`) may be listed by the array's path.
 */
export function inventoryProblems(
  inventory: FieldInventory,
  fixtures: readonly unknown[],
  vocabulary?: ProviderVocabulary,
): string[] {
  const problems = new Set<string>()
  for (const fixture of fixtures) {
    for (const path of fieldPaths(fixture)) {
      if (!isListed(inventory, path)) problems.add(`not in the inventory: ${path}`)
    }
  }
  if (vocabulary) {
    for (const [path, use] of Object.entries(inventory)) {
      if (typeof use === 'object' && 'extra' in use && !Object.hasOwn(vocabulary.extras ?? {}, use.extra)) {
        problems.add(`${path} is the extra "${use.extra}", which the vocabulary doesn't declare`)
      }
    }
  }
  return [...problems].sort()
}

/**
 * The extras a vocabulary declares that no inventory entry names: an extra no
 * feed field feeds. Pass every inventory the provider keeps (a listing and a
 * details response, say), since an extra may come from either:
 *
 *   expect(unfedExtras(vocabulary, recordInventory, detailsInventory)).toEqual([])
 */
export function unfedExtras(vocabulary: ProviderVocabulary, ...inventories: FieldInventory[]): string[] {
  const named = new Set(inventories.flatMap(inv => Object.values(inv))
    .flatMap(use => (typeof use === 'object' && 'extra' in use ? [use.extra] : [])))
  return Object.keys(vocabulary.extras ?? {}).filter(key => !named.has(key)).sort()
}

/** The path of every field in a value, as `inventoryProblems` names them. */
export function fieldPaths(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap(item => fieldPaths(item, `${path}[]`))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, v]) => fieldPaths(v, path ? `${path}.${key}` : key))
  }
  return path ? [path] : []
}

function isListed(inventory: FieldInventory, path: string): boolean {
  if (Object.hasOwn(inventory, path)) return true
  if (path.endsWith('[]') && Object.hasOwn(inventory, path.slice(0, -2))) return true
  // An ignored object or array covers everything inside it.
  for (let end = ancestorEnd(path, path.length); end > 0; end = ancestorEnd(path, end)) {
    const use = inventory[path.slice(0, end)]
    if (typeof use === 'object' && 'ignored' in use) return true
  }
  return false
}

/** Where the nearest ancestor of `path.slice(0, end)` ends: before its last `.` or `[]`, or 0 at the root. */
function ancestorEnd(path: string, end: number): number {
  const prefix = path.slice(0, end)
  if (prefix.endsWith('[]')) return end - 2
  return Math.max(prefix.lastIndexOf('.'), prefix.lastIndexOf('[]'), 0)
}
