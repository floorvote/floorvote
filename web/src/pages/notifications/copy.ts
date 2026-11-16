// The Notifications page's descriptions, in plain words. The page is each person's own settings, the same for every
// role, so there is one wording for each email.

/** What "digest" means, since the word is the name of the email in people's inboxes. */
export const DIGEST_DEFINITION = 'One email that sums up what changed on your bills since the last one.'

// The group is named the way the instance names it (its org noun: team, coalition, association), so these are functions.
export const priorityDescription = (orgNoun: string) => `Status changes, hearings, positions, and comments on bills your ${orgNoun} marked as a priority.`

export const weekAheadDescription = (orgNoun: string) => `Next week's hearings on your ${orgNoun}'s priority bills and events on your ${orgNoun} calendar.`

/** The part's title, which reads the same in the switch's name. */
export const newlyFoundTitle = (orgNoun: string) => `New bills that may be relevant to your ${orgNoun}`

export const newBillsDescription = (orgNoun: string) => `Bills that just matched your ${orgNoun}'s keywords.`

export const SAVED_VIEWS_DESCRIPTION = "A saved view is a filtered list of bills. Follow one with the envelope beside it in the Views menu on the Bills page."

const MUTE_HINT = 'To stop them on one bill, select “Mute comments” on that bill.'

export const REPLIES_DESCRIPTION = `You get these in FloorVote and by email. ${MUTE_HINT}`

/** Shown instead when the admin turned off email to members: replies still reach FloorVote, but not email. */
export const REPLIES_DESCRIPTION_APP_ONLY = `You get these in FloorVote. ${MUTE_HINT}`

/** The line at the top of the page when the admin turned off email to members. */
export const emailsOffLine = (orgNoun: string) => `Your ${orgNoun} has turned off email to members, so none of these emails are sent.`
