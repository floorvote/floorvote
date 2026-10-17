import type { ReactNode } from 'react'
import type { FieldChangeEvent } from '../../../shared/teamFields'
import type { ThreadLine } from '../lib/groupingLine'

type Options = { positionLabel?: string; renderBill?: (event: FieldChangeEvent) => ReactNode }

export function ActivityLine(_props: { event: FieldChangeEvent } & Options): ReactNode {
  return null
}

export function ActivityFold(_props: { actorName: string | null; events: FieldChangeEvent[] } & Options): ReactNode {
  return null
}

export function ThreadLineView(_props: { line: ThreadLine } & Options): ReactNode {
  return null
}
