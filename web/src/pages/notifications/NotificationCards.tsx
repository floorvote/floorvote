import { useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useConfig } from '../../context/ConfigContext'
import { useDemo } from '../../context/DemoContext'
import { apiFetch } from '../../lib/api'
import { digestSentPhrase, weekAheadSentPhrase, DEFAULT_WEEK_AHEAD_DAY } from '../../lib/notifications'
import { DEFAULT_ORG_NOUN } from '../../lib/orgNoun'
import { CARD_TITLE } from '../../lib/textStyles'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'
import { PART_TITLE, SettingCard, SwitchRow } from './SettingCard'
import { ScopeSelect } from '../../components/ui/ScopeSelect'
import { DIGEST_DEFINITION, newlyFoundTitle, priorityDescription, REPLIES_DESCRIPTION, REPLIES_DESCRIPTION_APP_ONLY, SAVED_VIEWS_DESCRIPTION, weekAheadDescription } from './copy'

interface Props {
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

/** A per-person yes/no kept on the user. Missing (an older API) reads as on, every switch's default. */
function useUserFlag(stored: boolean | undefined, field: string, onSaved?: (next: boolean) => void) {
  const { value, busy, change } = useUserSetting<boolean>(stored ?? true, field, onSaved)
  return { on: value, busy, change }
}

const capitalize = (phrase: string) => phrase.charAt(0).toUpperCase() + phrase.slice(1)

/** The How often menu's choices: every morning, then each weekday from Monday, stored as null or 0 (Sunday) to 6. */
const DIGEST_SCHEDULE_OPTIONS = ([null, 1, 2, 3, 4, 5, 6, 0] as const).map((d) => ({
  value: d === null ? 'daily' : String(d),
  label: capitalize(digestSentPhrase(d)),
}))

const DIVIDER: React.CSSProperties = { marginTop: 10, paddingTop: 10, borderTop: `1px solid ${color.borderDefault}` }

/** The three emails, each its own card, with this person's own switches. Every role sees the same ones. */
export function NotificationCards({ flashed }: Props) {
  const { user, setEmailDigestEnabled, setEmailDigestMatchesEnabled, setEmailDigestWeeklyDay, setEmailRepliesEnabled, setEmailWeekAheadEnabled } = useAuth()
  const { demoLocked } = useDemo()
  const { config } = useConfig()
  const orgNoun = config?.orgNoun ?? DEFAULT_ORG_NOUN
  const isAdmin = user?.role === 'admin' || user?.role === 'owner'
  // When the admin turned off email to members, no email here is sent, so the email controls are disabled and their
  // cards dim. The replies switch is the exception: it also covers replies in FloorVote, so it stays live and its card
  // stays bright. A missing setting (an older API, or a failed config read) reads as on.
  const emailsOn = config?.notificationEmailsEnabled !== false
  const locked = demoLocked || !emailsOn

  const digest = useUserFlag(user?.emailDigestEnabled, 'emailDigestEnabled', setEmailDigestEnabled)
  const newlyFound = useUserFlag(user?.emailDigestMatchesEnabled, 'emailDigestMatchesEnabled', setEmailDigestMatchesEnabled)
  // Every morning (null) or once a week on the weekday the person picked. A person starts at every morning.
  const digestDay = useUserSetting<number | null>(user?.emailDigestWeeklyDay ?? null, 'emailDigestWeeklyDay', setEmailDigestWeeklyDay)
  const weekAhead = useUserFlag(user?.emailWeekAheadEnabled, 'emailWeekAheadEnabled', setEmailWeekAheadEnabled)
  const replies = useUserFlag(user?.emailRepliesEnabled, 'emailRepliesEnabled', setEmailRepliesEnabled)
  const weekAheadDay = config?.weekAheadDay ?? DEFAULT_WEEK_AHEAD_DAY

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
    if (locked || followed === null) return
    const before = followed
    setFollowed(before.filter((v) => v.id !== id))
    try {
      await apiFetch(`/views/${id}/subscription`, { method: 'PUT', body: JSON.stringify({ subscribed: false }) })
    } catch {
      setFollowed(before)
    }
  }

  return (
    <>
      <SettingCard id="setting-email-digest" flashed={flashed === 'setting-email-digest'} dimmed={locked}>
        {/* The title and How often share the top row, the menu on the right where the other cards keep their switch.
            The definition runs below, across the whole card. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <h2 style={{ ...CARD_TITLE, marginBottom: 0 }}>Email digest</h2>
          {/* The app's own dropdown, which opens below its button like the others, not the browser's select. */}
          <div style={{ flexShrink: 0 }}>
            <ScopeSelect
              ariaLabel="How often"
              options={DIGEST_SCHEDULE_OPTIONS}
              value={digestDay.value === null ? 'daily' : String(digestDay.value)}
              disabled={locked || digestDay.busy}
              onChange={(v) => {
                const next = v === 'daily' ? null : Number(v)
                if (next !== digestDay.value) void digestDay.change(next)
              }}
            />
          </div>
        </div>
        <div style={{ marginTop: 2, fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5 }}>
          {DIGEST_DEFINITION}
        </div>

        <div style={DIVIDER}>
          <SwitchRow
            title="Changes to priority bills"
            titleId="priority-title"
            description={priorityDescription(orgNoun)}
            descriptionId="priority-description"
            checked={digest.on}
            disabled={locked}
            busy={digest.busy}
            onChange={(next) => { void digest.change(next) }}
          />
        </div>

        <div style={DIVIDER}>
          <SwitchRow
            title={newlyFoundTitle(orgNoun)}
            titleId="newly-found-title"
            checked={newlyFound.on}
            disabled={locked}
            busy={newlyFound.busy}
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
            <span style={PART_TITLE}>Saved views you follow</span>
            {followed !== null && followed.length > 0 && (
              <span style={{ color: color.textSecondary }}>{followed.length} {followed.length === 1 ? 'view' : 'views'}</span>
            )}
          </div>
          <div style={{ fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5 }}>{SAVED_VIEWS_DESCRIPTION}</div>
          {followedFailed && (
            <div role="alert" style={{ marginTop: 4, fontSize: fontSize.sm, color: color.textErrorRed }}>Couldn't load the saved views you follow.</div>
          )}
          {followed !== null && followed.length === 0 && (
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
                    disabled={locked}
                    onClick={() => { void unfollow(v.id) }}
                    style={{
                      fontFamily: 'inherit', fontSize: fontSize.base, lineHeight: 1, background: 'none', border: 'none',
                      color: color.textSecondary, cursor: locked ? 'not-allowed' : 'pointer', minWidth: 24, minHeight: 24, borderRadius: radius.pill,
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

      <SettingCard id="setting-week-ahead" flashed={flashed === 'setting-week-ahead'} dimmed={locked}>
        <SwitchRow
          titleVariant="card"
          title="Week ahead email"
          ariaLabel="Get the week ahead email"
          description={`${weekAheadDescription(orgNoun)} Sent ${weekAheadSentPhrase(weekAheadDay)}.`}
          checked={weekAhead.on}
          disabled={locked}
          busy={weekAhead.busy}
          onChange={(next) => { void weekAhead.change(next) }}
        />
      </SettingCard>

      <SettingCard dimmed={demoLocked}>
        <h2 style={CARD_TITLE}>Comments</h2>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5 }}>
          <div>
            <div style={PART_TITLE}>Someone mentions you</div>
            <div>{emailsOn ? alwaysEmailedLine(isAdmin, roleCount) : "You'll see it in FloorVote."}</div>
          </div>
          {emailsOn && <span style={{ color: color.textSecondary, fontWeight: fontWeight.medium, flexShrink: 0 }}>Always on</span>}
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
            description={emailsOn ? REPLIES_DESCRIPTION : REPLIES_DESCRIPTION_APP_ONLY}
            checked={replies.on}
            disabled={demoLocked}
            busy={replies.busy}
            onChange={(next) => { void replies.change(next) }}
          />
        </div>
      </SettingCard>
    </>
  )
}
