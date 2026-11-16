import { useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useConfig } from '../../context/ConfigContext'
import { useDemo } from '../../context/DemoContext'
import { apiFetch } from '../../lib/api'
import { digestSentPhrase, newlyFoundOn, weekAheadSentPhrase } from '../../lib/modules'
import { DEFAULT_ORG_NOUN } from '../../lib/orgNoun'
import { CARD } from '../../lib/cardStyle'
import { CARD_TITLE } from '../../lib/textStyles'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'
import { NoteLine, SettingCard, SwitchRow, TurnedOffNote } from './SettingCard'
import { ScopeSelect } from '../../components/ui/ScopeSelect'
import type { TeamSettings } from './useTeamSettings'
import { DIGEST_DEFINITION, DIGEST_ONLY_WHEN_CHANGED, newlyFoundTip, newlyFoundTitle, priorityDescription, REPLIES_DESCRIPTION, REPLIES_DESCRIPTION_APP_ONLY, SAVED_VIEWS_DESCRIPTION, SAVED_VIEWS_TIP, teamDefaultNote, weekAheadDescription } from './copy'
import { InfoTooltip } from '../../components/InfoTooltip'

interface Props {
  team: TeamSettings
  /** The setting id being flashed after a deep link, if any. */
  flashed: string | null
}

// Names only the mentions that can reach this person: everyone gets direct
// and @everyone mentions, a role member their role's, an admin or owner @admins.
function alwaysEmailedLine(isAdmin: boolean, roleCount: number): string {
  const kinds = ['you']
  if (roleCount === 1) kinds.push('your role')
  if (roleCount > 1) kinds.push('one of your roles')
  if (isAdmin) kinds.push('@admins')
  kinds.push('@everyone')
  const list = kinds.length === 2 ? kinds.join(' or ') : `${kinds.slice(0, -1).join(', ')}, or ${kinds[kinds.length - 1]}`
  return `You'll always get an email when someone mentions ${list}.`
}

/** A per-person setting kept on the user (`PATCH /users/me`): shown at once, put back if the save fails. */
function useUserSetting<T>(stored: T, field: string, onSaved?: (next: T) => void) {
  const [value, setValue] = useState<T>(stored)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setValue(stored) }, [stored])
  async function change(next: T) {
    const before = value
    setValue(next)
    setBusy(true)
    try {
      await apiFetch('/users/me', { method: 'PATCH', body: JSON.stringify({ [field]: next }) })
      onSaved?.(next)
    } catch {
      setValue(before)
    } finally {
      setBusy(false)
    }
  }
  return { value, busy, change }
}

/**
 * A per-person yes/no kept on the user. A choice not made yet (null) shows as `fallback`, and `unset` says so. Changing
 * the switch makes the choice.
 */
function useUserFlag(stored: boolean | null | undefined, field: string, onSaved?: (next: boolean) => void, fallback = true) {
  const { value, busy, change } = useUserSetting<boolean | null>(stored ?? null, field, onSaved && ((next) => onSaved(next === true)))
  return { on: value ?? fallback, unset: value === null, busy, change: (next: boolean) => change(next) }
}

const capitalize = (phrase: string) => phrase.charAt(0).toUpperCase() + phrase.slice(1)

/** The How often menu's choices: every morning, then each weekday from Monday, stored as null or 0 (Sunday) to 6. */
const DIGEST_SCHEDULE_OPTIONS = ([null, 1, 2, 3, 4, 5, 6, 0] as const).map((d) => ({
  value: d === null ? 'daily' : String(d),
  label: capitalize(digestSentPhrase(d)),
}))

const SECTION_CARD: React.CSSProperties = { ...CARD, padding: 24, marginBottom: 20 }
const DIVIDER: React.CSSProperties = { marginTop: 10, paddingTop: 10, borderTop: `1px solid ${color.borderDefault}` }
// No intro line sits under this heading. The first card keeps the spacing the team section's intro has around it,
// without the line itself: the heading's own 6 to the line, and the line's 12 to the first card.
const HEADING_ABOVE_CARDS: React.CSSProperties = { ...CARD_TITLE, marginBottom: 18 }

/** "Your notifications": what this person gets. Same emails, same order, as "For your whole {org noun}". */
export function YourNotifications({ team, flashed }: Props) {
  const { user, setEmailDigestEnabled, setEmailDigestMatchesEnabled, setEmailDigestWeeklyDay, setEmailRepliesEnabled, setEmailWeekAheadEnabled } = useAuth()
  const { demoLocked } = useDemo()
  const { config } = useConfig()
  const orgNoun = config?.orgNoun ?? DEFAULT_ORG_NOUN
  const isAdmin = user?.role === 'admin' || user?.role === 'owner'

  // What the team turned off. Until the settings arrive, assume nothing so no row flashes "turned off". Under Saved views
  // only the priority and new bills parts are off and the views stay yours. Under Off all three are.
  const digestChoice = team.loaded ? team.digestChoice : 'all'
  const partsOff = digestChoice === 'views' || digestChoice === 'off'
  const viewsOff = digestChoice === 'off'
  const weekAheadOff = team.loaded && !team.weekAheadOn
  const commentsOff = team.loaded && !team.commentEmailsOn

  const digest = useUserFlag(user?.emailDigestEnabled, 'emailDigestEnabled', setEmailDigestEnabled)
  // Until the person chooses, "New bills" is the team's default for a member and on for an admin or owner. A
  // member sees "Your team's default." under it then, unless the team turned the part off. The default comes with the
  // team's settings, so until they arrive a member's unset switch and its note wait, rather than show a guess.
  const newlyFound = useUserFlag(user?.emailDigestMatchesEnabled, 'emailDigestMatchesEnabled', setEmailDigestMatchesEnabled,
    newlyFoundOn(null, user?.role ?? 'member', team.modules))
  const newlyFoundWaits = !isAdmin && newlyFound.unset && !team.loaded
  const showTeamDefault = !isAdmin && newlyFound.unset && team.loaded && !partsOff
  // Every morning (null) or once a week on the weekday the person picked. A person starts at every morning.
  const digestDay = useUserSetting<number | null>(user?.emailDigestWeeklyDay ?? null, 'emailDigestWeeklyDay', setEmailDigestWeeklyDay)
  const weekAhead = useUserFlag(user?.emailWeekAheadEnabled, 'emailWeekAheadEnabled', setEmailWeekAheadEnabled)
  const replies = useUserFlag(user?.emailRepliesEnabled, 'emailRepliesEnabled', setEmailRepliesEnabled)

  // How many roles this person is in, for the always-on mention line. Until /roles answers,
  // or if it fails, the line leaves roles out.
  const [roleCount, setRoleCount] = useState(0)
  useEffect(() => {
    apiFetch<Array<{ members?: Array<{ id: string }> }>>('/roles')
      .then((roles) => setRoleCount(Array.isArray(roles) ? roles.filter((r) => r.members?.some((m) => m.id === user?.id)).length : 0))
      .catch(() => {})
  }, [user?.id])

  // The saved views this person follows. A failed or empty read is no views.
  const [followed, setFollowed] = useState<Array<{ id: string; name: string }> | null>(null)
  const [followedFailed, setFollowedFailed] = useState(false)
  useEffect(() => {
    apiFetch<{ views?: Array<{ id: string; name: string; subscribed?: boolean }> }>('/views')
      .then((d) => setFollowed((d.views ?? []).filter((v) => v.subscribed).map(({ id, name }) => ({ id, name }))))
      .catch(() => setFollowedFailed(true))
  }, [])

  async function unfollow(id: string) {
    if (demoLocked || followed === null) return
    const before = followed
    setFollowed(before.filter((v) => v.id !== id))
    try {
      await apiFetch(`/views/${id}/subscription`, { method: 'PUT', body: JSON.stringify({ subscribed: false }) })
    } catch {
      setFollowed(before)
    }
  }

  // A switch the team turned off shows off, disabled, with the "Turned off" note (SwitchRow's `turnedOffBy`).
  const offBy = (off: boolean) => (off ? orgNoun : undefined)

  return (
    <div style={SECTION_CARD}>
      <h2 style={HEADING_ABOVE_CARDS}>Your notifications</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <SettingCard id="setting-email-digest" flashed={flashed === 'setting-email-digest'} dimmed={demoLocked}>
          {/* The heading and How often share the top row, the menu on the right where the other cards keep their switch.
              The definition runs below, across the whole card. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div role="heading" aria-level={3} style={{ fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: color.textPrimary, lineHeight: 1.5 }}>Email digest</div>
            {/* The app's own dropdown, which opens below its button like the others, not the browser's select. */}
            <div style={{ flexShrink: 0, opacity: viewsOff ? 0.55 : 1 }}>
              <ScopeSelect
                ariaLabel="How often"
                options={DIGEST_SCHEDULE_OPTIONS}
                value={digestDay.value === null ? 'daily' : String(digestDay.value)}
                disabled={demoLocked || viewsOff || digestDay.busy}
                onChange={(v) => {
                  const next = v === 'daily' ? null : Number(v)
                  if (next !== digestDay.value) void digestDay.change(next)
                }}
              />
            </div>
          </div>
          <div style={{ marginTop: 2, fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5 }}>
            {viewsOff || !team.loaded ? DIGEST_DEFINITION : `${DIGEST_DEFINITION} ${DIGEST_ONLY_WHEN_CHANGED}`}
          </div>

          <div style={{ ...DIVIDER, opacity: partsOff ? 0.55 : 1 }}>
            <SwitchRow
              title="Changes to priority bills"
              titleId="priority-title"
              description={priorityDescription(orgNoun)}
              descriptionId="priority-description"
              checked={digest.on}
              disabled={demoLocked}
              busy={digest.busy}
              turnedOffBy={offBy(partsOff)}
              onChange={(next) => { void digest.change(next) }}
            />
          </div>

          <div style={{ ...DIVIDER, opacity: partsOff ? 0.55 : 1 }}>
            <SwitchRow
              title={newlyFoundTitle(orgNoun)}
              titleId="newly-found-title"
              titleExtra={<InfoTooltip text={newlyFoundTip(orgNoun)} label="About new bills" align="left" maxWidth={280} />}
              description={showTeamDefault ? <NoteLine>{teamDefaultNote(orgNoun)}</NoteLine> : undefined}
              descriptionId="newly-found-description"
              checked={newlyFound.on}
              disabled={demoLocked}
              busy={newlyFound.busy}
              pending={newlyFoundWaits}
              turnedOffBy={offBy(partsOff)}
              onChange={(next) => { void newlyFound.change(next) }}
            />
          </div>

          {/* Outside any label, so a click on a chip never toggles a switch. */}
          <div
            id="setting-saved-views"
            style={{
              ...DIVIDER,
              borderRadius: radius.md,
              boxShadow: flashed === 'setting-saved-views' ? `0 0 0 3px ${color.borderAmber}` : undefined,
              transition: 'box-shadow 0.6s ease',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, fontSize: fontSize.sm }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: color.textPrimary }}>
                Saved views you follow
                {!viewsOff && <InfoTooltip text={SAVED_VIEWS_TIP} label="About saved views you follow" align="left" maxWidth={280} />}
              </span>
              {!viewsOff && followed !== null && followed.length > 0 && (
                <span style={{ color: color.textSecondary }}>{followed.length} {followed.length === 1 ? 'view' : 'views'}</span>
              )}
            </div>
            {/* Under Off only the words dim. The chips and their remove buttons stay at full strength, since removing still works. */}
            <div style={{ opacity: viewsOff ? 0.55 : 1 }}>
              <div style={{ fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5 }}>{SAVED_VIEWS_DESCRIPTION}</div>
              {viewsOff && <TurnedOffNote orgNoun={orgNoun} />}
            </div>
            {!viewsOff && followedFailed && (
              <div role="alert" style={{ marginTop: 4, fontSize: fontSize.sm, color: color.textErrorRed }}>Couldn't load the saved views you follow.</div>
            )}
            {!viewsOff && followed !== null && followed.length === 0 && (
              <div style={{ marginTop: 4, fontSize: fontSize.sm, color: color.textMuted }}>
                You don't follow any saved views yet.
              </div>
            )}
            {followed !== null && followed.length > 0 && (
              <ul aria-label="Saved views you follow" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0 0', padding: 0, listStyle: 'none' }}>
                {followed.map((v) => (
                  <li
                    key={v.id}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 4px 2px 10px',
                      border: `1px solid ${color.borderDefault}`, borderRadius: radius.pill,
                      fontSize: fontSize.sm, color: color.textSlate, background: color.white,
                    }}
                  >
                    {v.name}
                    <button
                      type="button"
                      aria-label={`Remove ${v.name}`}
                      disabled={demoLocked}
                      onClick={() => { void unfollow(v.id) }}
                      style={{
                        fontFamily: 'inherit', fontSize: fontSize.base, lineHeight: 1, background: 'none', border: 'none',
                        color: color.textSecondary, cursor: demoLocked ? 'not-allowed' : 'pointer', minWidth: 24, minHeight: 24, borderRadius: radius.pill,
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SettingCard>

        <SettingCard id="setting-week-ahead" flashed={flashed === 'setting-week-ahead'} dimmed={demoLocked || weekAheadOff}>
          <SwitchRow
            heading
            title="Week ahead email"
            ariaLabel="Get the week ahead email"
            description={weekAheadOff || !team.loaded ? weekAheadDescription(orgNoun) : `${weekAheadDescription(orgNoun)} Sent ${weekAheadSentPhrase(team.modules)}.`}
            checked={weekAhead.on}
            disabled={demoLocked}
            busy={weekAhead.busy}
            turnedOffBy={offBy(weekAheadOff)}
            onChange={(next) => { void weekAhead.change(next) }}
          />
        </SettingCard>

        <SettingCard dimmed={demoLocked}>
          <div role="heading" aria-level={3} style={{ fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: color.textPrimary }}>Comments</div>
          {commentsOff && <NoteLine>Comment emails are turned off by your {orgNoun}.</NoteLine>}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginTop: 8, fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5 }}>
            <div>
              <div style={{ color: color.textPrimary }}>Someone mentions you</div>
              <div>{commentsOff ? "You'll see it in FloorVote." : alwaysEmailedLine(isAdmin, roleCount)}</div>
            </div>
            {!commentsOff && <span style={{ color: color.textSecondary, fontWeight: fontWeight.medium, flexShrink: 0 }}>Always on</span>}
          </div>
          <div
            id="setting-email-replies"
            style={{
              ...DIVIDER,
              borderRadius: radius.md,
              boxShadow: flashed === 'setting-email-replies' ? `0 0 0 3px ${color.borderAmber}` : undefined,
              transition: 'box-shadow 0.6s ease',
            }}
          >
            <SwitchRow
              title="Someone replies on a bill you commented on"
              ariaLabel="Someone replies on a bill you commented on"
              description={commentsOff ? REPLIES_DESCRIPTION_APP_ONLY : REPLIES_DESCRIPTION}
              checked={replies.on}
              disabled={demoLocked}
              busy={replies.busy}
              onChange={(next) => { void replies.change(next) }}
            />
          </div>
        </SettingCard>
      </div>
    </div>
  )
}
