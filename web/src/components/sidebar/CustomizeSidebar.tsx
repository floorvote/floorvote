import { useState } from 'react'
import type { CSSProperties, Ref, RefObject } from 'react'
import { apiFetch } from '../../lib/api'
import {
  MODULES,
  isModuleEnabled,
  getModuleSetting,
  visibleModuleSettings,
} from '../../lib/modules'
import type { ModulesConfig, ModuleSettingValue } from '../../lib/modules'
import { useConfig } from '../../context/ConfigContext'
import { DEFAULT_ORG_NOUN } from '../../lib/orgNoun'
import { IosToggle } from '../ui/IosToggle'
import { ScopeSelect } from '../ui/ScopeSelect'
import { color, radius, fontSize, fontWeight, shadow } from '../../styles/tokens'
import { PopPanel, type PopPanelHandle } from '../ui/PopPanel'

function normalize(
  entry: ModulesConfig[string] | undefined,
): { enabled: boolean; settings: Record<string, ModuleSettingValue> } {
  if (entry === true) return { enabled: true, settings: {} }
  if (entry === false || entry == null) return { enabled: false, settings: {} }
  if (typeof entry === 'object') return { enabled: entry.enabled === true, settings: { ...(entry.settings ?? {}) } }
  return { enabled: false, settings: {} }
}

export function CustomizeSidebarPanel({
  modules,
  onSaved,
}: {
  modules: ModulesConfig
  onSaved: () => void
}) {
  const [state, setState] = useState<ModulesConfig>(modules)
  const [savingId, setSavingId] = useState<string | null>(null)
  const org = useConfig().config?.orgNoun ?? DEFAULT_ORG_NOUN

  async function save(next: ModulesConfig, id: string) {
    const prev = state
    setState(next)
    setSavingId(id)
    try {
      await apiFetch('/admin/config', { method: 'PUT', body: JSON.stringify({ modules: next }) })
      onSaved()
    } catch {
      setState(prev)
    } finally {
      setSavingId(null)
    }
  }

  function toggle(id: string, next: boolean) {
    const cur = normalize(state[id])
    save(
      {
        ...state,
        [id]: Object.keys(cur.settings).length ? { enabled: next, settings: cur.settings } : next,
      },
      id,
    )
  }

  function changeSetting(id: string, key: string, value: ModuleSettingValue) {
    const cur = normalize(state[id])
    save(
      { ...state, [id]: { enabled: cur.enabled, settings: { ...cur.settings, [key]: value } } },
      id,
    )
  }

  return (
    <div
      style={{
        background: color.white,
        border: `1px solid ${color.borderDefault}`,
        borderRadius: radius.md,
        boxShadow: shadow.md,
        padding: 14,
        width: 300,
        maxWidth: '90vw',
      }}
    >
      <div style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, marginBottom: 2 }}>
        Customize widgets
      </div>
      <div style={{ fontSize: fontSize.xs, color: color.textMuted, marginBottom: 10 }}>
        Applies to everyone in your {org}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {MODULES.filter(m => m.type === 'widget').map((m) => {
          const enabled = isModuleEnabled(state, m.id)
          return (
            <div
              key={m.id}
              style={{
                border: `1px solid ${color.borderDefault}`,
                borderRadius: radius.md,
                padding: '10px 12px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
                    {m.name}
                  </div>
                  {m.description && (
                    <div style={{ fontSize: fontSize.xs, color: color.textMuted }}>{m.description}</div>
                  )}
                </div>
                <IosToggle
                  checked={enabled}
                  disabled={false}
                  busy={savingId === m.id}
                  onChange={(n) => toggle(m.id, n)}
                  ariaLabel={`Toggle ${m.name}`}
                />
              </div>
              {(() => {
                const visible = visibleModuleSettings(m, state)
                if (visible.length === 0) return null
                return (
                  <div
                    style={{
                      marginTop: 10,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      opacity: enabled ? 1 : 0.5,
                    }}
                  >
                    {visible.map((s) => {
                      const current = getModuleSetting(state, m.id, s.key, s.default)
                      const isRich = s.type === 'select' && s.options?.some((o) => o.description)
                      return (
                        <div
                          key={s.key}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            gap: 8,
                            fontSize: fontSize.xs,
                            color: color.textSlate500,
                          }}
                        >
                          <span>{s.label}</span>
                          {isRich ? (
                            <ScopeSelect
                              options={s.options!}
                              value={String(current)}
                              defaultValue={String(s.default)}
                              disabled={!enabled}
                              align="left"
                              onChange={(v) => changeSetting(m.id, s.key, v)}
                            />
                          ) : s.type === 'select' ? (
                            <select
                              value={String(current)}
                              disabled={!enabled}
                              onChange={(e) =>
                                changeSetting(m.id, s.key, s.numeric ? Number(e.target.value) : e.target.value)
                              }
                              style={{
                                fontSize: fontSize.xs,
                                padding: '3px 6px',
                                borderRadius: radius.sm,
                                border: `1px solid ${color.borderDefault}`,
                                fontFamily: 'inherit',
                              }}
                            >
                              {s.options!.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="number"
                              value={Number(current)}
                              disabled={!enabled}
                              min={s.min}
                              max={s.max}
                              onChange={(e) => {
                                const n = Number(e.target.value)
                                if (!Number.isFinite(n)) return
                                const clamped = Math.max(
                                  s.min ?? -Infinity,
                                  Math.min(s.max ?? Infinity, n),
                                )
                                changeSetting(m.id, s.key, clamped)
                              }}
                              style={{
                                fontSize: fontSize.xs,
                                padding: '3px 6px',
                                borderRadius: radius.sm,
                                border: `1px solid ${color.borderDefault}`,
                                width: 70,
                                fontFamily: 'inherit',
                              }}
                            />
                          )}
                          {s.suffix && <span>{s.suffix}</span>}
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface CustomizeSidebarProps {
  modules: ModulesConfig
  onSaved: () => void
  onClose: () => void
  positionStyle: CSSProperties
  triggerRef?: RefObject<HTMLElement | null>
}

export function CustomizeSidebar(
  { modules, onSaved, onClose, positionStyle, triggerRef, ref }: CustomizeSidebarProps & { ref?: Ref<PopPanelHandle> },
) {
  return (
    <PopPanel
      ref={ref}
      onClose={onClose}
      triggerRef={triggerRef}
      ariaLabel="Customize widgets"
      transformOrigin="bottom left"
      enterOffsetY={6}
      positionStyle={positionStyle}
    >
      <CustomizeSidebarPanel modules={modules} onSaved={onSaved} />
    </PopPanel>
  )
}
