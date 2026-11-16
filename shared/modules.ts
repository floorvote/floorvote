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

/**
 * The modules a new instance starts with, read whenever an instance has never saved its own (api/src/lib/modulesConfig.ts).
 * The team's emails: the email digest with priority bills and saved views, with new bills off for members unless they
 * turn them on, and the week ahead email on Fridays. How often the digest comes is each person's own choice. Migration 0129 saved an empty set for every instance
 * that already had people, so these reach only new ones.
 */
export const DEFAULT_MODULES: ModulesConfig = {
  'email-digest': { enabled: true, settings: { teamUpdates: true, newBillsDefault: false } },
  'week-ahead': { enabled: true, settings: { weeklyDay: '5' } },
}

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

/**
 * What the team chose for the email digest: "on" (priority bills, newly found bills, and saved views), "views"
 * (only the saved views each person follows), or "off" (no one gets it). Stored as the module's `enabled` plus
 * `teamUpdates`, which is on unless it is set to false, so a module saved before the choice existed reads as "on".
 */
export type DigestTeamChoice = 'on' | 'views' | 'off'
export function digestTeamChoice(modules: ModulesConfig | undefined): DigestTeamChoice {
  if (!isModuleEnabled(modules, 'email-digest')) return 'off'
  return getModuleSetting<boolean>(modules, 'email-digest', 'teamUpdates', true) === false ? 'views' : 'on'
}

/**
 * What members get unless they change it (#1036): "Members get them" (true) or "Members don't get
 * them" (false), under "Newly found bills, unless a member changes it". Stored as the email-digest module's `newBillsDefault`, which is on unless it is set to false.
 */
export function newBillsDefault(modules: ModulesConfig | undefined): boolean {
  return getModuleSetting<boolean>(modules, 'email-digest', 'newBillsDefault', true) !== false
}

/**
 * Whether a person's "Newly found bills" part is on: their own choice once they made one. With none (null), a member
 * follows the team's default, and an admin or owner gets the part, since they decide which new bills the team follows.
 */
export function newlyFoundOn(choice: boolean | null | undefined, role: string, modules: ModulesConfig | undefined): boolean {
  if (typeof choice === 'boolean') return choice
  return role === 'admin' || role === 'owner' || newBillsDefault(modules)
}

/** When a person's email digest is sent, as a phrase for a sentence: "every morning", or "every Friday morning" for one weekly on a weekday (0 Sunday to 6 Saturday). */
export function digestSentPhrase(weeklyDay: number | null | undefined): string {
  if (weeklyDay == null || !WEEKDAYS[weeklyDay]) return 'every morning'
  return `every ${WEEKDAYS[weeklyDay]} morning`
}

/** When the week ahead email is sent, as a phrase for a sentence: "every Monday morning" unless another day is set. */
export function weekAheadSentPhrase(modules: ModulesConfig | undefined): string {
  const day = WEEKDAYS[Number(getModuleSetting(modules, 'week-ahead', 'weeklyDay', '1'))] ?? 'Monday'
  return `every ${day} morning`
}

/** Maps a module type to a human-readable kind label. */
export function moduleKindLabel(type: ModuleType): string {
  return type === 'widget' ? 'Widget' : 'Page'
}

