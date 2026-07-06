import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import { COUNT_BADGE, displayName } from '../lib/chipStyles'
import { color, radius, fontSize, fontWeight, shadow } from '../styles/tokens'

interface UserItem {
  id: string
  name: string
  email: string
  subtitle: string | null
  type: 'user'
}

interface RoleItem {
  id: string
  name: string
  memberCount: number
  type: 'role'
}

interface EveryoneItem {
  id: 'all'
  memberCount: number
  type: 'everyone'
}

type SuggestionItem = UserItem | RoleItem | EveryoneItem

export interface MentionSuggestionsRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

interface Props {
  items: SuggestionItem[]
  command: (item: { id: string; label: string }) => void
}

function isMoreIndicator(item: SuggestionItem) {
  return item.id === '__more_users__' || item.id === '__more_roles__'
}

export function MentionSuggestions({ items, command, ref }: Props & { ref?: Ref<MentionSuggestionsRef> }) {
    const [selectedIndex, setSelectedIndex] = useState(0)
    const itemRefs = useRef<Map<number, HTMLElement>>(new Map())

    const selectableItems = items.filter(i => !isMoreIndicator(i))

    useEffect(() => setSelectedIndex(0), [items])

    useEffect(() => {
      // Map selectedIndex (into selectableItems) back to globalIndex for scrolling
      const selectable = items.reduce<number[]>((acc, item, i) => {
        if (!isMoreIndicator(item)) acc.push(i)
        return acc
      }, [])
      const globalIdx = selectable[selectedIndex]
      if (globalIdx != null) {
        const el = itemRefs.current.get(globalIdx)
        if (el) el.scrollIntoView({ block: 'nearest' })
      }
    }, [selectedIndex, items])

    const setRef = useCallback((globalIdx: number, el: HTMLElement | null) => {
      if (el) itemRefs.current.set(globalIdx, el)
      else itemRefs.current.delete(globalIdx)
    }, [])

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (event.key === 'ArrowUp') {
          setSelectedIndex((prev) => (prev + selectableItems.length - 1) % selectableItems.length)
          return true
        }
        if (event.key === 'ArrowDown') {
          setSelectedIndex((prev) => (prev + 1) % selectableItems.length)
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab' || event.key === ' ') {
          if (selectableItems.length > 0) {
            handleSelect(selectedIndex)
            return true
          }
        }
        return false
      },
    }))

    function handleSelect(selectableIdx: number) {
      const item = selectableItems[selectableIdx]
      if (!item) return
      if (item.type === 'everyone') {
        command({ id: 'everyone:all', label: 'everyone' })
        return
      }
      const prefix = item.type === 'role' ? 'role' : 'user'
      const label = item.type === 'user' ? displayName(item) : item.name
      command({ id: `${prefix}:${item.id}`, label })
    }

    if (items.length === 0) return null

    const everyone = items.find((i): i is EveryoneItem => i.type === 'everyone')
    const people = items.filter((i): i is UserItem => i.type === 'user')
    const roles = items.filter((i): i is RoleItem => i.type === 'role')

    // Build a map from globalIndex → selectableIndex for highlight matching
    let selectableIdx = 0
    const globalToSelectable = new Map<number, number>()
    items.forEach((item, i) => {
      if (!isMoreIndicator(item)) {
        globalToSelectable.set(i, selectableIdx++)
      }
    })

    let globalIndex = -1

    return (
      <div style={{
        background: color.white,
        border: `1px solid ${color.borderDefault}`,
        borderRadius: radius.lg,
        boxShadow: shadow.md,
        maxHeight: 280,
        overflowY: 'auto',
        minWidth: 220,
      }}>
        {everyone && (() => {
          globalIndex++
          const gi = globalIndex
          const si = globalToSelectable.get(gi)!
          return (
            <button
              ref={el => {
                setRef(gi, el);
              }}
              key="everyone"
              onClick={() => handleSelect(si)}
              style={{
                display: 'flex',
                alignItems: 'center',
                width: '100%',
                textAlign: 'left',
                padding: '6px 12px',
                border: 'none',
                background: si === selectedIndex ? color.bgInfo : 'transparent',
                cursor: 'pointer',
                fontSize: fontSize.sm,
                color: color.tooltipBg,
                fontFamily: 'inherit',
                borderBottom: `1px solid ${color.borderDefault}`,
              }}
            >
              <span style={{ fontWeight: fontWeight.medium }}>everyone</span>
              <span style={{ color: color.textMuted, marginLeft: 6 }}>Notify all members</span>
              <span style={{ ...COUNT_BADGE, marginLeft: 'auto' }}>
                {everyone.memberCount} {everyone.memberCount === 1 ? 'user' : 'users'}
              </span>
            </button>
          );
        })()}
        {people.length > 0 && (
          <>
            <div style={{ padding: '6px 12px', fontSize: fontSize.sm, color: color.textMuted, fontWeight: fontWeight.semibold, textTransform: 'uppercase' }}>
              People
            </div>
            {people.map((person) => {
              globalIndex++
              const gi = globalIndex
              const isMore = isMoreIndicator(person)
              if (isMore) {
                return (
                  <div key="more-users" style={{ padding: '4px 12px 6px', fontSize: fontSize.sm, color: color.textMuted, fontStyle: 'italic' }}>
                    {person.subtitle}…
                  </div>
                )
              }
              const si = globalToSelectable.get(gi)!
              return (
                <button
                  ref={el => {
                    setRef(gi, el);
                  }}
                  key={`user-${person.id}`}
                  onClick={() => handleSelect(si)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 12px',
                    border: 'none',
                    background: si === selectedIndex ? color.bgInfo : 'transparent',
                    cursor: 'pointer',
                    fontSize: fontSize.sm,
                    fontFamily: 'inherit',
                  }}
                >
                  <span style={{ color: color.tooltipBg }}>{displayName(person)}</span>
                  {person.subtitle && (
                    <span style={{ color: color.textMuted, marginLeft: 6 }}>{person.subtitle}</span>
                  )}
                </button>
              );
            })}
          </>
        )}
        {roles.length > 0 && (
          <>
            <div style={{
              padding: '6px 12px',
              fontSize: fontSize.sm,
              color: color.textMuted,
              fontWeight: fontWeight.semibold,
              textTransform: 'uppercase',
              borderTop: people.length > 0 ? `1px solid ${color.borderDefault}` : 'none',
            }}>
              Roles
            </div>
            {roles.map((role) => {
              globalIndex++
              const gi = globalIndex
              const isMore = isMoreIndicator(role)
              if (isMore) {
                return (
                  <div key="more-roles" style={{ padding: '4px 12px 6px', fontSize: fontSize.sm, color: color.textMuted, fontStyle: 'italic' }}>
                    {role.name}…
                  </div>
                )
              }
              const si = globalToSelectable.get(gi)!
              return (
                <button
                  ref={el => {
                    setRef(gi, el);
                  }}
                  key={`role-${role.id}`}
                  onClick={() => handleSelect(si)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 12px',
                    border: 'none',
                    background: si === selectedIndex ? color.bgInfo : 'transparent',
                    cursor: 'pointer',
                    fontSize: fontSize.sm,
                    color: color.tooltipBg,
                    fontFamily: 'inherit',
                  }}
                >
                  <span>{role.name}</span>
                  <span style={{ ...COUNT_BADGE, marginLeft: 'auto' }}>
                    {role.memberCount} {role.memberCount === 1 ? 'user' : 'users'}
                  </span>
                </button>
              );
            })}
          </>
        )}
      </div>
    );
}
