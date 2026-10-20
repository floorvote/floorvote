import type { DemoSeed } from '../../src/lib/demoSeeds'

/**
 * A minimal single-state demo seed, for tests only. It is deliberately not
 * registered in DEMO_SEEDS: the shipped seed (lake-michigan) covers several
 * states, so this is what keeps the reset's single-state branch (a STATE-scoped
 * tenant, with no state_coverage list) covered. It carries just enough for a
 * reset to write a roster and a config.
 */
export const SINGLE_STATE_SEED: DemoSeed = {
  slug: 'test-single-state',
  associationName: 'Single-State Fixture',
  bannerText: 'A fixture seed for tests.',
  orgNoun: 'team',
  aiContext: 'You are analyzing a bill for a fixture team.',
  relevanceQuestion: 'Rate the bill\'s relevance to a fixture team.',
  tagTaxonomy: [{ name: 'Fixture', description: 'A tag the fixture seed carries.' }],
  keywords: ['fixture*'],
  positionVocabulary: ['Support', 'Oppose'],
  modules: { calendar: true },
  sessions: { data: [] },
  stateCoverage: null,

  users: [
    { id: 'demo-user', email: 'demo@example.com', name: 'Demo User', role: 'admin', title: 'Fixture', createdDaysAgo: 30, canVote: true, lastActiveDaysAgo: 0 },
    { id: 'fixture-member', email: 'member@example.com', name: 'Fixture Member', role: 'member', title: 'Fixture', createdDaysAgo: 10, canVote: true, lastActiveDaysAgo: 1 },
  ],
  roles: [{ id: 'fixture-role', name: 'Fixture Role' }],
  userRoles: [{ userId: 'fixture-member', roleId: 'fixture-role' }],
  customFields: [],

  priorities: [],
  positions: [],
  votes: [],
  comments: [],
  reactions: [],
  mentions: [],
  feedEvents: [],
  customFieldValues: [],
  notes: [],
  calendarEvents: [],
  teamFieldChanges: [],
  savedViews: [],
}
