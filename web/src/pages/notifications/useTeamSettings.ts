import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../lib/api'
import { isModuleEnabled, digestTeamChoice, newBillsDefault } from '../../lib/modules'
import type { ModulesConfig, ModuleSettingValue } from '../../lib/modules'
import { useConfig } from '../../context/ConfigContext'
import { useSidebarRefresh } from '../../context/SidebarRefreshContext'

type ModuleId = 'email-digest' | 'week-ahead'

/**
 * The team's choice for the email digest, one flat group of four: everything, priority bills and saved views (new bills
 * off by default), saved views only, or off.
 */
export type DigestChoice = 'all' | 'priority' | 'views' | 'off'

export interface TeamSettings {
  /** False until the instance's settings have come back. Nothing says "turned off" before then, and a failed read leaves it false. */
  loaded: boolean
  /** True when the read failed. Nothing about the team's settings is shown or saved until a retry succeeds. */
  loadFailed: boolean
  /** Read the settings again after a failure. */
  retryLoad: () => void
  modules: ModulesConfig
  /** What the team chose for the email digest, read from `enabled`, `teamUpdates` and `newBillsDefault`. */
  digestChoice: DigestChoice
  /** What members get unless they change it: true for "Members get them", false for "Members don't get them". */
  newBillsDefault: boolean
  weekAheadOn: boolean
  /** The "Send emails about comments" switch. */
  commentEmailsOn: boolean
  /** The key of the setting being saved, for a switch's busy state. */
  saving: string | null
  saveError: boolean
  /** Turn an email on or off, or change its schedule. Settings merge into what the module already has. */
  saveModule: (id: ModuleId, patch: { enabled?: boolean; settings?: Record<string, ModuleSettingValue> }) => void
  /** Choose one of the four: the module's `enabled`, `teamUpdates` and `newBillsDefault` settings. */
  saveDigestChoice: (choice: DigestChoice) => void
  saveCommentEmails: (next: boolean) => void
}

const DEFAULT_SETTINGS: Record<ModuleId, Record<string, ModuleSettingValue>> = {
  'email-digest': {},
  'week-ahead': { weeklyDay: '1' },
}

/**
 * The instance's email settings, shared by both halves of the Notifications page:
 * "For your whole {org noun}" edits them, and "Your notifications" reads them to say
 * which emails the team turned off. Everyone can read them (`GET /config`); only an
 * admin or owner can save (`PUT /admin/config`).
 */
export function useTeamSettings(): TeamSettings {
  const refreshSidebar = useSidebarRefresh()
  const { setModules: setAppModules } = useConfig()
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [modules, setModules] = useState<ModulesConfig>({})
  const [commentEmailsOn, setCommentEmailsOn] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [saveError, setSaveError] = useState(false)

  useEffect(() => {
    let live = true
    setLoadFailed(false)
    apiFetch<{ modules?: ModulesConfig; mentionEmailsEnabled?: boolean }>('/config')
      .then((c) => {
        if (!live) return
        setModules(c.modules ?? {})
        setCommentEmailsOn(c.mentionEmailsEnabled !== false)
        setLoaded(true)
      })
      // A failed read stays unloaded: drawing it as loaded would show "off" for everything and let a save wipe the
      // instance's other modules.
      .catch(() => { if (live) setLoadFailed(true) })
    return () => { live = false }
  }, [attempt])

  const retryLoad = useCallback(() => setAttempt((n) => n + 1), [])

  const put = useCallback(async (body: Record<string, unknown>, key: string, revert: () => void) => {
    setSaving(key)
    setSaveError(false)
    try {
      await apiFetch('/admin/config', { method: 'PUT', body: JSON.stringify(body) })
      refreshSidebar()
      // The app read /config once; hand it the saved modules so module-gated UI (the Bills page envelope) follows.
      if (body.modules) setAppModules?.(body.modules as Record<string, unknown>)
    } catch {
      revert()
      setSaveError(true)
    } finally {
      setSaving(null)
    }
  }, [refreshSidebar, setAppModules])

  const saveModule: TeamSettings['saveModule'] = (id, patch) => {
    const before = modules
    const current = modules[id]
    const currentSettings = typeof current === 'object' && current !== null ? current.settings ?? {} : {}
    const entry = {
      enabled: patch.enabled ?? isModuleEnabled(modules, id),
      settings: { ...DEFAULT_SETTINGS[id], ...currentSettings, ...patch.settings },
    }
    const next = { ...modules, [id]: entry }
    setModules(next)
    void put({ modules: next }, id, () => setModules(before))
  }

  // Off leaves the other settings as they were, and Saved views only leaves `newBillsDefault`. The two upper choices
  // set `teamUpdates` on and `newBillsDefault` on or off, so a later read gives the same choice back.
  const saveDigestChoice = (choice: DigestChoice) => {
    if (choice === 'off') saveModule('email-digest', { enabled: false })
    else if (choice === 'views') saveModule('email-digest', { enabled: true, settings: { teamUpdates: false } })
    else saveModule('email-digest', { enabled: true, settings: { teamUpdates: true, newBillsDefault: choice === 'all' } })
  }

  const teamChoice = digestTeamChoice(modules)
  const digestChoice: DigestChoice = teamChoice === 'off' ? 'off' : teamChoice === 'views' ? 'views' : newBillsDefault(modules) ? 'all' : 'priority'

  const saveCommentEmails = (next: boolean) => {
    setCommentEmailsOn(next)
    void put({ mention_emails_enabled: next }, 'comments', () => setCommentEmailsOn(!next))
  }

  return {
    loaded,
    loadFailed,
    retryLoad,
    modules,
    digestChoice,
    newBillsDefault: newBillsDefault(modules),
    weekAheadOn: isModuleEnabled(modules, 'week-ahead'),
    commentEmailsOn,
    saving,
    saveError,
    saveModule,
    saveDigestChoice,
    saveCommentEmails,
  }
}
