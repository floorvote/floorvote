import { useConfig } from '../../context/ConfigContext'
import { useDemo } from '../../context/DemoContext'
import { DEFAULT_ORG_NOUN } from '../../lib/orgNoun'
import { getModuleSetting } from '../../lib/modules'
import { CARD } from '../../lib/cardStyle'
import { CARD_TITLE, HELPER_TEXT, SR_ONLY } from '../../lib/textStyles'
import { color, fontSize, fontWeight } from '../../styles/tokens'
import { SettingCard, SwitchRow } from './SettingCard'
import { SELECT, SelectField } from './SelectField'
import type { DigestChoice, TeamSettings } from './useTeamSettings'
import { TEAM_COMMENTS_DESCRIPTION, TEAM_DIGEST_CHOICES, TEAM_DIGEST_DESCRIPTION, weekAheadDescription } from './copy'

const WEEKDAYS = [
  ['0', 'Sunday'],
  ['1', 'Monday'],
  ['2', 'Tuesday'],
  ['3', 'Wednesday'],
  ['4', 'Thursday'],
  ['5', 'Friday'],
  ['6', 'Saturday'],
] as const

const SECTION_CARD: React.CSSProperties = { ...CARD, padding: 24, marginBottom: 20 }

// Turning an email OFF stops it for everyone, so ask first (a browser confirm, like the
// rest of the app). Turning it ON is harmless, so it applies at once. Members can opt out
// of the digest and the week ahead email themselves, but not of mention emails, so the
// comments confirm leaves the opt-out sentence off.
function confirmOff(what: string, pronoun: 'it' | 'them', membersCanOptOut: boolean): boolean {
  return window.confirm(
    `Turn off ${what} for everyone? This stops ${pronoun} for all members, not just you.${membersCanOptOut ? ' Members can also opt out individually on their Notifications tab.' : ''}`,
  )
}

// Switching the digest to Saved views only stops the priority and new bills parts for every person, so it asks first
// like turning an email off does. The views each person follows keep coming, so the wording says so.
function confirmViewsOnly(): boolean {
  return window.confirm(
    'Switch the email digest to saved views only for everyone? This stops priority bills and new bills for all members, not just you. Members still get the saved views they follow.',
  )
}

// Each group of radios is its own <fieldset>, named by its <legend>, drawn without the fieldset's own box.
const FIELDSET: React.CSSProperties = { border: 'none', padding: 0, margin: 0, minWidth: 0 }

/** The email digest's one choice of four. Each choice is drawn with its description, so nothing is hidden behind a menu. */
function DigestChoiceGroup({ value, disabled, busy, onChoose }: { value: DigestChoice; disabled: boolean; busy: boolean; onChoose: (next: DigestChoice) => void }) {
  return (
    <fieldset style={{ ...FIELDSET, marginTop: 8 }}>
      {/* The card's heading already reads "Email digest", so only a screen reader hears the group's name. */}
      <legend style={SR_ONLY}>Send the email digest</legend>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {TEAM_DIGEST_CHOICES.map((c) => {
          const titleId = `notif-digest-choice-${c.value}`
          const cursor = disabled ? 'not-allowed' : 'pointer'
          return (
            <div key={c.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: fontSize.sm, lineHeight: 1.5 }}>
              <input
                type="radio"
                id={`${titleId}-input`}
                name="notif-digest-choice"
                value={c.value}
                checked={value === c.value}
                disabled={disabled}
                aria-labelledby={titleId}
                aria-describedby={'description' in c ? `${titleId}-description` : undefined}
                onChange={() => { if (!busy && value !== c.value) onChoose(c.value) }}
                style={{ marginTop: 4, flexShrink: 0, cursor }}
              />
              <div>
                <label htmlFor={`${titleId}-input`} style={{ display: 'block', cursor }}>
                  <span id={titleId} style={{ display: 'block', color: color.textPrimary, fontWeight: fontWeight.medium }}>{c.title}</span>
                  {'description' in c && <span id={`${titleId}-description`} style={{ display: 'block', color: color.textSlate }}>{c.description}</span>}
                </label>
              </div>
            </div>
          )
        })}
      </div>
    </fieldset>
  )
}

function Schedule({ dimmed, children }: { dimmed: boolean; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 12, paddingLeft: 4, display: 'flex', flexDirection: 'column', gap: 10, opacity: dimmed ? 0.5 : 1 }}>
      {children}
    </div>
  )
}

function DayOptions() {
  return <>{WEEKDAYS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</>
}

/** "For your whole {org noun}": admins and owners only. The switches here stop an email for every person. */
export function TeamNotifications({ team }: { team: TeamSettings }) {
  const { demoLocked } = useDemo()
  const { config } = useConfig()
  const orgNoun = config?.orgNoun ?? DEFAULT_ORG_NOUN
  const { modules } = team
  const weekAheadDay = getModuleSetting<string>(modules, 'week-ahead', 'weeklyDay', '1')

  return (
    <div style={SECTION_CARD}>
      <h2 style={CARD_TITLE}>For your whole {orgNoun}</h2>
      <p style={{ ...HELPER_TEXT, marginTop: 0, marginBottom: 12 }}>
        These settings apply to everyone. Turning an email off stops it for every person.
      </p>
      {!team.loaded ? (
        <div style={{ color: color.textMuted, fontSize: fontSize.sm }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <SettingCard dimmed={demoLocked}>
            <div role="heading" aria-level={3} style={{ fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: color.textPrimary }}>Email digest</div>
            <div style={{ fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5 }}>{TEAM_DIGEST_DESCRIPTION}</div>
            <DigestChoiceGroup
              value={team.digestChoice}
              disabled={demoLocked}
              busy={team.saving === 'email-digest'}
              onChoose={(next) => {
                if (next === 'off' && !confirmOff('the email digest', 'it', true)) return
                if (next === 'views' && (team.digestChoice === 'all' || team.digestChoice === 'priority') && !confirmViewsOnly()) return
                team.saveDigestChoice(next)
              }}
            />
          </SettingCard>

          <SettingCard dimmed={demoLocked}>
            <SwitchRow
              heading
              title="Week ahead email"
              ariaLabel="Send the week ahead email"
              description={weekAheadDescription(orgNoun)}
              checked={team.weekAheadOn}
              disabled={demoLocked}
              busy={team.saving === 'week-ahead'}
              onChange={(next) => {
                if (!next && !confirmOff('the week ahead email', 'it', true)) return
                team.saveModule('week-ahead', { enabled: next })
              }}
            />
            <Schedule dimmed={!team.weekAheadOn}>
              <SelectField id="notif-weekahead-weekday" label="Day of week">
                <select
                  id="notif-weekahead-weekday"
                  value={weekAheadDay}
                  disabled={!team.weekAheadOn || demoLocked}
                  onChange={(e) => team.saveModule('week-ahead', { settings: { weeklyDay: e.target.value } })}
                  style={SELECT}
                >
                  <DayOptions />
                </select>
              </SelectField>
            </Schedule>
          </SettingCard>

          <SettingCard dimmed={demoLocked}>
            <SwitchRow
              heading
              title="Comment emails"
              ariaLabel="Send emails about comments"
              description={TEAM_COMMENTS_DESCRIPTION}
              checked={team.commentEmailsOn}
              disabled={demoLocked}
              busy={team.saving === 'comments'}
              onChange={(next) => {
                if (!next && !confirmOff('comment emails', 'them', false)) return
                team.saveCommentEmails(next)
              }}
            />
          </SettingCard>

          {team.saveError && (
            <div role="alert" style={{ fontSize: fontSize.sm, color: color.textErrorRed }}>Couldn't save that change. Try again.</div>
          )}
        </div>
      )}
    </div>
  )
}
