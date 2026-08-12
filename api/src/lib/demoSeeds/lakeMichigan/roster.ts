import type { DemoSeedCustomField, DemoSeedRole, DemoSeedUser } from '../types'

// Fifteen staff of a fictional regional water-policy organization working the
// Lake Michigan basin.
//
// Persona names were vetted on 2026-08-11 against real Great Lakes water-policy,
// conservation, and environmental-advocacy figures. Eight of the fifteen — every
// senior or publicly-visible title — were searched individually and returned no
// topical collision. The remaining seven hold junior analyst and coordinator
// titles, where a collision is both less likely and less consequential; they were
// not searched one by one. Known real individuals in this space, never to be used:
// Don Carr and Angela Larsen (Alliance for the Great Lakes), Celia Haven (Healing
// Our Waters). Any ordinary name matches someone somewhere; the bar tested here is
// a topical collision, not global uniqueness.
//
// lastActiveDaysAgo is staggered to give a realistic active curve: 11
// personas active within 7 days, the rest within 30 — the sidebar member
// count and the admin active-member stats both read this field.
export const LM_USERS: DemoSeedUser[] = [
  { id: 'demo-user',       email: 'demo@example.com',   name: 'Marcus Weir',       role: 'admin',  subtitle: 'Policy Director',              createdDaysAgo: 90, canVote: true,  lastActiveDaysAgo: 0 },
  { id: 'lm-user-ed',      email: 'karen@demo.example', name: 'Karen Waters',   role: 'admin',  subtitle: 'Executive Director',           createdDaysAgo: 88, canVote: true,  lastActiveDaysAgo: 0 },
  { id: 'lm-user-dep',     email: 'varsha@demo.example', name: 'Varsha Raman',       role: 'admin',  subtitle: 'Deputy Policy Director',       createdDaysAgo: 85, canVote: true,  lastActiveDaysAgo: 1 },
  { id: 'lm-user-la1',     email: 'devon@demo.example', name: 'Devon Brook',      role: 'member', subtitle: 'Legislative Analyst',          createdDaysAgo: 80, canVote: true,  lastActiveDaysAgo: 1 },
  { id: 'lm-user-la2',     email: 'sofia@demo.example', name: 'Sofia Marino',   role: 'member', subtitle: 'Legislative Analyst',          createdDaysAgo: 75, canVote: true,  lastActiveDaysAgo: 2 },
  { id: 'lm-user-wq',      email: 'trevor@demo.example', name: 'Trevor Beck',      role: 'member', subtitle: 'Water Quality Analyst',        createdDaysAgo: 70, canVote: true,  lastActiveDaysAgo: 2 },
  { id: 'lm-user-gov',     email: 'marina@demo.example', name: 'Marina Okafor',    role: 'member', subtitle: 'Government Affairs Manager',   createdDaysAgo: 65, canVote: true,  lastActiveDaysAgo: 3 },
  { id: 'lm-user-fed',     email: 'aaron@demo.example', name: 'Aaron Teichman',     role: 'member', subtitle: 'Federal Policy Manager',       createdDaysAgo: 60, canVote: true,  lastActiveDaysAgo: 4 },
  { id: 'lm-user-res',     email: 'grace@demo.example', name: 'Grace Jiang',         role: 'member', subtitle: 'Research Associate',           createdDaysAgo: 55, canVote: true,  lastActiveDaysAgo: 5 },
  { id: 'lm-user-comms',   email: 'renee@demo.example', name: 'Renee Rains',      role: 'member', subtitle: 'Communications Director',      createdDaysAgo: 50, canVote: true,  lastActiveDaysAgo: 6 },
  { id: 'lm-user-gc',      email: 'paul@demo.example',  name: 'Paul Ford',     role: 'member', subtitle: 'General Counsel',              createdDaysAgo: 45, canVote: true,  lastActiveDaysAgo: 7 },
  { id: 'lm-user-grants',  email: 'tanya@demo.example', name: 'Tanya Wells',      role: 'member', subtitle: 'Grants Manager',               createdDaysAgo: 40, canVote: true,  lastActiveDaysAgo: 10 },
  { id: 'lm-user-prog',    email: 'miguel@demo.example', name: 'Miguel Rivera',     role: 'member', subtitle: 'Program Coordinator',          createdDaysAgo: 35, canVote: true,  lastActiveDaysAgo: 14 },
  { id: 'lm-user-data',    email: 'nina@demo.example',  name: 'Nina Potocnik',        role: 'member', subtitle: 'Data Analyst',                 createdDaysAgo: 32, canVote: true,  lastActiveDaysAgo: 20 },
  { id: 'lm-user-out',     email: 'josh@demo.example',  name: 'Josh Marsh',     role: 'member', subtitle: 'Outreach Coordinator',         createdDaysAgo: 30, canVote: false, lastActiveDaysAgo: 28 },
]

// Five jurisdiction teams (one per covered legislature) plus three working
// groups. Later tasks reference these exact ids in @mention markup.
export const LM_ROLES: DemoSeedRole[] = [
  { id: 'lm-role-mi', name: 'Michigan Team' },
  { id: 'lm-role-wi', name: 'Wisconsin Team' },
  { id: 'lm-role-il', name: 'Illinois Team' },
  { id: 'lm-role-in', name: 'Indiana Team' },
  { id: 'lm-role-us', name: 'Federal Team' },
  { id: 'lm-role-infra', name: 'Infrastructure' },
  { id: 'lm-role-contam', name: 'Contaminants' },
  { id: 'lm-role-habitat', name: 'Habitat' },
]

// Every person sits on exactly one jurisdiction team (3 per team). 10 of the
// 15 also carry a working group; the remaining 5 carry none.
export const LM_USER_ROLES: Array<{ userId: string; roleId: string }> = [
  // Michigan Team
  { userId: 'demo-user',      roleId: 'lm-role-mi' },
  { userId: 'lm-user-la1',    roleId: 'lm-role-mi' },
  { userId: 'lm-user-comms',  roleId: 'lm-role-mi' },
  // Wisconsin Team
  { userId: 'lm-user-la2',    roleId: 'lm-role-wi' },
  { userId: 'lm-user-wq',     roleId: 'lm-role-wi' },
  { userId: 'lm-user-data',   roleId: 'lm-role-wi' },
  // Illinois Team
  { userId: 'lm-user-dep',    roleId: 'lm-role-il' },
  { userId: 'lm-user-gov',    roleId: 'lm-role-il' },
  { userId: 'lm-user-gc',     roleId: 'lm-role-il' },
  // Indiana Team
  { userId: 'lm-user-res',    roleId: 'lm-role-in' },
  { userId: 'lm-user-prog',   roleId: 'lm-role-in' },
  { userId: 'lm-user-out',    roleId: 'lm-role-in' },
  // Federal Team
  { userId: 'lm-user-ed',     roleId: 'lm-role-us' },
  { userId: 'lm-user-fed',    roleId: 'lm-role-us' },
  { userId: 'lm-user-grants', roleId: 'lm-role-us' },

  // Infrastructure working group
  { userId: 'demo-user',      roleId: 'lm-role-infra' },
  { userId: 'lm-user-la2',    roleId: 'lm-role-infra' },
  { userId: 'lm-user-gov',    roleId: 'lm-role-infra' },
  { userId: 'lm-user-grants', roleId: 'lm-role-infra' },
  // Contaminants working group
  { userId: 'lm-user-dep',    roleId: 'lm-role-contam' },
  { userId: 'lm-user-la1',    roleId: 'lm-role-contam' },
  { userId: 'lm-user-wq',     roleId: 'lm-role-contam' },
  // Habitat working group
  { userId: 'lm-user-res',    roleId: 'lm-role-habitat' },
  { userId: 'lm-user-prog',   roleId: 'lm-role-habitat' },
  { userId: 'lm-user-data',   roleId: 'lm-role-habitat' },
]

export const LM_CUSTOM_FIELDS: DemoSeedCustomField[] = [
  { id: 'lm-cf-1', name: 'Fiscal Impact', slug: 'fiscal-impact', type: 'dropdown',
    options: ['No Impact', 'Minimal (<$10K)', 'Moderate ($10K-$100K)', 'Significant (>$100K)', 'Unknown'],
    displayOrder: 1 },
  { id: 'lm-cf-2', name: 'Working Group', slug: 'working-group', type: 'dropdown',
    options: ['Infrastructure', 'Contaminants', 'Habitat'], displayOrder: 2 },
  { id: 'lm-cf-3', name: 'Policy Concerns', slug: 'policy-concerns', type: 'text',
    options: null, displayOrder: 3, pinned: true },
  { id: 'lm-cf-4', name: 'Compliance Deadline', slug: 'compliance-deadline', type: 'date',
    options: null, displayOrder: 4 },
  { id: 'lm-cf-5', name: 'Testimony Submitted', slug: 'testimony', type: 'binary',
    options: null, displayOrder: 5 },
]
