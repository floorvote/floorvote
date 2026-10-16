/**
 * How two bills relate, the same across legislatures. Each provider's
 * vocabulary maps its own relationship labels (LegiScan's "Same As," the
 * Maryland General Assembly's "Cross-filed") to one of these, and central
 * sends the kind with every related bill.
 *
 * - `identical`: the same bill filed twice, usually one in each chamber.
 *   Identical companions are the ones that can share a discussion.
 * - `package`: different bills the legislature moves together, such as
 *   Michigan's tie-barred bills.
 * - `related`: anything else the legislature links, and the kind of any label
 *   a vocabulary doesn't map.
 */
export const RELATIONSHIP_KINDS = ['identical', 'package', 'related'] as const

export type RelationshipKind = typeof RELATIONSHIP_KINDS[number]

export function isRelationshipKind(value: unknown): value is RelationshipKind {
  return typeof value === 'string' && (RELATIONSHIP_KINDS as readonly string[]).includes(value)
}

/** What the bill page calls each kind, ahead of its bill numbers. */
export const RELATIONSHIP_KIND_LABELS: Readonly<Record<RelationshipKind, string>> = {
  identical: 'Identical to',
  package: 'Part of a package',
  related: 'Related',
}
