// The Notifications page's descriptions, in plain words. Each email has the same
// name and wording in "For your whole {org noun}" and "Your notifications", so a
// team setting can be matched to the personal one it governs.

/** What "digest" means, since the word is the name of the email in people's inboxes. */
export const DIGEST_DEFINITION = 'One email that sums up what changed on your bills since the last one.'

/** After the definition on a person's digest card. How often is the menu under it. */
export const DIGEST_ONLY_WHEN_CHANGED = 'Sent only when something changed.'

// The group is named the way the instance names it (its org noun: team, coalition, association), so these are functions.
export const priorityDescription = (orgNoun: string) => `Status changes, hearings, positions, and comments on bills your ${orgNoun} marked as a priority.`

export const weekAheadDescription = (orgNoun: string) => `Next week's hearings on your ${orgNoun}'s priority bills and events on your ${orgNoun} calendar.`

/** The personal row's title, which reads the same in the switch's name. Its hover is `newlyFoundTip`. */
export const newlyFoundTitle = (orgNoun: string) => `New bills that may be relevant to your ${orgNoun}`

export const newlyFoundTip = (orgNoun: string) => `Bills that just matched your ${orgNoun}'s keywords.`

/** The hover on "Saved views you follow". Ends in a period, like the app's other InfoTooltip texts. */
export const SAVED_VIEWS_TIP = "A saved view is a filtered list of bills. Follow one by clicking the envelope beside it in the Views menu on the Bills page. You get these even with the two parts above off, and a bill already under priority bills isn't repeated."

export const SAVED_VIEWS_DESCRIPTION = "You'll get an email with what changed in each one you follow."

const MUTE_HINT = 'To stop them on one bill, select “Mute comments” on that bill.'

export const REPLIES_DESCRIPTION = `You get these in FloorVote and by email. ${MUTE_HINT}`

/** Shown instead when the team turned comment emails off: replies still reach FloorVote, but not email. */
export const REPLIES_DESCRIPTION_APP_ONLY = `You get these in FloorVote. ${MUTE_HINT}`

export const TEAM_DIGEST_DESCRIPTION = DIGEST_DEFINITION

/** The team's four choices for the email digest, in order. Each says what it stores in `useTeamSettings`'s `saveDigestChoice`. */
export const TEAM_DIGEST_CHOICES = [
  { value: 'all', title: 'Priority bills, new bills, and saved views', description: 'Each person can unsubscribe from any of them.' },
  { value: 'priority', title: 'Priority bills and saved views', description: 'Admins still get new bills by default, and members can turn them on.' },
  { value: 'views', title: 'Saved views only', description: 'Includes only the saved views each person follows.' },
  { value: 'off', title: 'Off' },
] as const

/** Under a member's "New bills" while they haven't chosen, so the switch shows the team's default. */
export const teamDefaultNote = (orgNoun: string) => `Your ${orgNoun}'s default.`

export const TEAM_COMMENTS_DESCRIPTION = 'Emails when someone mentions a member, a role, @admins, or @everyone, and when someone replies on a bill a member commented on. Members still see mentions and replies in FloorVote when this is off.'
