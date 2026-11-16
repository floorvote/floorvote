import { describe, it, expect } from 'vitest'
import { MODULES, isModuleEnabled, getModuleSetting, visibleModuleSettings, digestSentPhrase, weekAheadSentPhrase, moduleKindLabel, digestTeamChoice } from './modules'
import type { ModuleDef } from './modules'

describe('MODULES registry', () => {
  it('includes the waiting-for-vote widget', () => {
    const m = MODULES.find((x) => x.id === 'waiting-for-vote')
    expect(m).toBeDefined()
    expect(m!.type).toBe('widget')
    expect(m!.name).toBeTruthy()
    expect(m!.description).toBeTruthy()
  })

  it('has unique module ids', () => {
    const ids = MODULES.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('isModuleEnabled', () => {
  it('returns false when modules is undefined', () => {
    expect(isModuleEnabled(undefined, 'waiting-for-vote')).toBe(false)
  })

  it('returns false when the key is missing', () => {
    expect(isModuleEnabled({}, 'waiting-for-vote')).toBe(false)
  })

  it('returns false when the key is explicitly false', () => {
    expect(isModuleEnabled({ 'waiting-for-vote': false }, 'waiting-for-vote')).toBe(false)
  })

  it('returns true when the key is exactly the boolean true', () => {
    expect(isModuleEnabled({ 'waiting-for-vote': true }, 'waiting-for-vote')).toBe(true)
  })

  it('returns true when the key is an object with enabled:true', () => {
    expect(
      isModuleEnabled({ 'upcoming-hearings': { enabled: true } }, 'upcoming-hearings'),
    ).toBe(true)
  })

  it('returns false when the key is an object with enabled:false', () => {
    expect(
      isModuleEnabled({ 'upcoming-hearings': { enabled: false } }, 'upcoming-hearings'),
    ).toBe(false)
  })
})

describe('getModuleSetting', () => {
  it('returns the fallback when modules is undefined', () => {
    expect(getModuleSetting(undefined, 'upcoming-hearings', 'lookaheadDays', 30)).toBe(30)
  })

  it('returns the fallback when entry is a bare boolean', () => {
    expect(
      getModuleSetting(
        { 'upcoming-hearings': true },
        'upcoming-hearings',
        'lookaheadDays',
        30,
      ),
    ).toBe(30)
  })

  it('returns the stored value when present', () => {
    expect(
      getModuleSetting(
        { 'upcoming-hearings': { enabled: true, settings: { lookaheadDays: 14 } } },
        'upcoming-hearings',
        'lookaheadDays',
        30,
      ),
    ).toBe(14)
  })

  it('returns string settings', () => {
    expect(
      getModuleSetting(
        { 'upcoming-hearings': { enabled: true, settings: { scope: 'high_priority_only' } } },
        'upcoming-hearings',
        'scope',
        'all_tracked',
      ),
    ).toBe('high_priority_only')
  })
})

describe('visibleModuleSettings', () => {
  // Define a local module def since email-digest was removed from the registry
  const emailDigest: ModuleDef = {
    id: 'email-digest',
    type: 'section',
    name: 'Email digest',
    description: 'Email digest',
    settings: [
      { key: 'frequency', type: 'select', label: 'Frequency', default: 'daily', options: [{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }] },
      { key: 'weeklyDay', type: 'select', label: 'Day of week', default: '1', options: [], showWhen: { key: 'frequency', equals: 'weekly' } },
    ],
  }

  it('hides weeklyDay when frequency is daily (default/unset)', () => {
    const visible = visibleModuleSettings(emailDigest, {})
    expect(visible.map((s) => s.key)).toEqual(['frequency'])
  })

  it('shows weeklyDay when frequency is weekly', () => {
    const cfg = { 'email-digest': { enabled: true, settings: { frequency: 'weekly' } } }
    const visible = visibleModuleSettings(emailDigest, cfg)
    expect(visible.map((s) => s.key)).toEqual(['frequency', 'weeklyDay'])
  })
})

describe('MODULES registry (post-rework)', () => {
  it('contains only toggleable sidebar widgets (widget type)', () => {
    const ids = MODULES.filter(m => m.type === 'widget').map(m => m.id).sort()
    expect(ids).toEqual(['upcoming-hearings', 'waiting-for-vote'])
  })
  it('week-ahead is a section-type module', () => {
    const m = MODULES.find(x => x.id === 'week-ahead')
    expect(m).toBeDefined()
    expect(m?.type).toBe('section')
  })
  it('no longer lists calendar, email-digest, or polls', () => {
    const ids = MODULES.map(m => m.id)
    expect(ids).not.toContain('calendar')
    expect(ids).not.toContain('email-digest')
    expect(ids).not.toContain('polls')
  })
  it('maps module type to a human kind label', () => {
    expect(moduleKindLabel('widget')).toBe('Widget')
    expect(moduleKindLabel('section')).toBe('Page')
  })
})

describe('upcoming-hearings widget config', () => {
  const m = MODULES.find((x) => x.id === 'upcoming-hearings')!

  it('is named "Upcoming hearings" with a fixed-behavior hint description', () => {
    expect(m.name).toBe('Upcoming hearings')
    expect(m.description).toBe('Show hearings for prioritized bills in the next 30 days.')
  })

  it('has no configurable settings (always prioritized bills, next 30 days)', () => {
    expect(m.settings).toBeUndefined()
  })
})

describe('digestSentPhrase', () => {
  it('says every morning for a daily digest', () => {
    expect(digestSentPhrase(null)).toBe('every morning')
    expect(digestSentPhrase(undefined)).toBe('every morning')
  })

  it('names the weekday of a weekly digest, from Sunday (0) to Saturday (6)', () => {
    expect(digestSentPhrase(0)).toBe('every Sunday morning')
    expect(digestSentPhrase(3)).toBe('every Wednesday morning')
    expect(digestSentPhrase(6)).toBe('every Saturday morning')
  })

  it('says every morning for a day that is not a weekday', () => {
    expect(digestSentPhrase(7)).toBe('every morning')
  })
})

describe('digestTeamChoice', () => {
  it('is On for an enabled digest with no teamUpdates setting, or with it on', () => {
    expect(digestTeamChoice({ 'email-digest': true })).toBe('on')
    expect(digestTeamChoice({ 'email-digest': { enabled: true } })).toBe('on')
    expect(digestTeamChoice({ 'email-digest': { enabled: true, settings: { frequency: 'daily' } } })).toBe('on')
    expect(digestTeamChoice({ 'email-digest': { enabled: true, settings: { teamUpdates: true } } })).toBe('on')
  })

  it('is Saved views only for an enabled digest with teamUpdates off', () => {
    expect(digestTeamChoice({ 'email-digest': { enabled: true, settings: { teamUpdates: false } } })).toBe('views')
  })

  it('is Off for a disabled or missing digest, whatever teamUpdates says', () => {
    expect(digestTeamChoice(undefined)).toBe('off')
    expect(digestTeamChoice({})).toBe('off')
    expect(digestTeamChoice({ 'email-digest': false })).toBe('off')
    expect(digestTeamChoice({ 'email-digest': { enabled: false, settings: { teamUpdates: true } } })).toBe('off')
    expect(digestTeamChoice({ 'email-digest': { enabled: false, settings: { teamUpdates: false } } })).toBe('off')
  })
})

describe('weekAheadSentPhrase', () => {
  it('names the weekday, Monday when no day is set', () => {
    expect(weekAheadSentPhrase({ 'week-ahead': { enabled: true } })).toBe('every Monday morning')
    expect(weekAheadSentPhrase(undefined)).toBe('every Monday morning')
    expect(weekAheadSentPhrase({ 'week-ahead': { enabled: true, settings: { weeklyDay: '4' } } })).toBe('every Thursday morning')
  })
})
