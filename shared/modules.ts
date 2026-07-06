export type ModuleType = 'widget' | 'section'
export type ModuleSettingValue = number | string | boolean

export interface ModuleSettingDef {
  key: string
  type: 'number' | 'select'
  /** Inline label rendered before the control, read as a sentence fragment. */
  label: string
  /** Optional text rendered after the control (e.g. "days"). */
  suffix?: string
  description?: string
  default: ModuleSettingValue
  /** Options whose `description` is set render as a rich dropdown with hover hints. */
  options?: Array<{ value: string; label: string; description?: string }>
  /** For `select` controls: store the chosen value as a number rather than a string. */
  numeric?: boolean
  min?: number
  max?: number
  /** Only render this setting when another setting in the same module equals a value. */
  showWhen?: { key: string; equals: ModuleSettingValue }
}

export interface ModuleDef {
  id: string
  type: ModuleType
  name: string
  description: string
  /** Greyed out, toggle disabled — feature not built yet. */
  comingSoon?: boolean
  settings?: ModuleSettingDef[]
}

export type ModuleConfigEntry =
  | boolean
  | { enabled: boolean; settings?: Record<string, ModuleSettingValue> }

export type ModulesConfig = Record<string, ModuleConfigEntry>

export const MODULES: ModuleDef[] = [
  {
    id: 'waiting-for-vote',
    type: 'widget',
    name: 'Prioritized bills',
    description:
      "Show prioritized bills, highlighting bills that the current user hasn't voted on yet.",
  },
  {
    id: 'upcoming-hearings',
    type: 'widget',
    name: 'Upcoming hearings',
    description: 'Show hearings for prioritized bills in the next 30 days.',
  },
  {
    id: 'week-ahead',
    type: 'section' as const,
    name: 'Week ahead email',
    description: 'Send members a weekly preview of upcoming hearings and calendar events grouped by day.',
    settings: [
      {
        key: 'weeklyDay',
        type: 'select' as const,
        label: 'Day of week',
        default: '1',
        options: [
          { value: '0', label: 'Sunday' },
          { value: '1', label: 'Monday' },
          { value: '2', label: 'Tuesday' },
          { value: '3', label: 'Wednesday' },
          { value: '4', label: 'Thursday' },
          { value: '5', label: 'Friday' },
          { value: '6', label: 'Saturday' },
        ],
      },
    ],
  },
]

export function isModuleEnabled(
  modules: ModulesConfig | undefined,
  id: string,
): boolean {
  const m = modules?.[id]
  if (m === true) return true
  if (typeof m === 'object' && m !== null) return m.enabled === true
  return false
}

export function getModuleSetting<T extends ModuleSettingValue>(
  modules: ModulesConfig | undefined,
  id: string,
  key: string,
  fallback: T,
): T {
  const m = modules?.[id]
  if (typeof m === 'object' && m !== null && m.settings && key in m.settings) {
    return m.settings[key] as T
  }
  return fallback
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Settings to render for a module, dropping any whose `showWhen` condition isn't met. */
export function visibleModuleSettings(m: ModuleDef, modules: ModulesConfig | undefined): ModuleSettingDef[] {
  if (!m.settings) return []
  return m.settings.filter((s) => {
    if (!s.showWhen) return true
    const sibling = m.settings!.find((x) => x.key === s.showWhen!.key)
    const current = getModuleSetting(modules, m.id, s.showWhen.key, sibling?.default ?? '')
    return String(current) === String(s.showWhen.equals)
  })
}

/** Human description of the recent-bill-activity digest cadence for the Account page. */
export function digestCadenceDescription(modules: ModulesConfig | undefined): string {
  const subject = 'recent activity on priority bills'
  // When the admin has the digest turned off, do not assert a cadence — the
  // Account row shows a "Turned off by your {org noun}." note instead.
  if (!isModuleEnabled(modules, 'email-digest')) return `A summary of ${subject}.`
  const frequency = getModuleSetting<string>(modules, 'email-digest', 'frequency', 'daily')
  if (frequency !== 'weekly') return `A daily summary of ${subject}.`
  const day = WEEKDAYS[Number(getModuleSetting(modules, 'email-digest', 'weeklyDay', '1'))] ?? 'Monday'
  return `A weekly summary of ${subject}, sent every ${day} morning.`
}

/** Human description of the week-ahead (upcoming hearings & events) digest cadence for the Account page. */
export function weekAheadCadenceDescription(modules: ModulesConfig | undefined): string {
  const subject = 'upcoming hearings and events'
  // When the admin has it turned off, do not assert a cadence — the Account row
  // shows a "Turned off by your {org noun}." note instead.
  if (!isModuleEnabled(modules, 'week-ahead')) return `A preview of ${subject}.`
  const day = WEEKDAYS[Number(getModuleSetting(modules, 'week-ahead', 'weeklyDay', '1'))] ?? 'Monday'
  return `A weekly preview of ${subject}, sent every ${day} morning.`
}

/** Maps a module type to a human-readable kind label. */
export function moduleKindLabel(type: ModuleType): string {
  return type === 'widget' ? 'Widget' : 'Page'
}
