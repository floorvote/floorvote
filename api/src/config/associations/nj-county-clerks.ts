export const NJ_COUNTY_CLERKS = {
  name: 'NJ County Clerks',
  description: 'Tuned for New Jersey county clerk associations. Covers elections, land records, court administration, and OPRA.',

  keywords: [
    'election',
    'ballot',
    'vote by mail',
    'county clerk',
    'board of elections',
    'deed',
    'land records',
    'public records',
    'OPRA',
    'notary',
    'voter',
  ],

  aiContext: `You are analyzing a bill for an association of New Jersey county clerks. Their duties include: elections administration (ballot design and printing, Vote by Mail applications, candidate petitions, certifying results), recording deeds and land documents, serving the Superior Court, issuing passports and marriage licenses, registering trade names, certifying notary publics, and managing public records requests under OPRA (Open Public Records Act).

Note: NJ county boards of elections — a separate body from the county clerk — operate polling places, maintain the voter database, and hire poll workers.

When writing the summary, start directly with an action verb or gerund phrase — do not begin with "This bill", "The bill", or the bill number. For example, you could start with "Requires all counties to...", "Establishes a new procedure for...", etc.

Scale the description to the bill's complexity and relevance. For less relevant, simple, or narrow bills 1–2 plain sentences should suffice. For bills that are longer and more relevant, you might write a paragraph or two. For a bill with multiple distinct provisions, you might also—or instead—use a list of 2–8 items, with the most impactful provisions first (unless there is some other order that would be more logical). Each item should start with a verb and be one sentence. You should aim to minimize redundancy in the description.`,

  relevanceQuestion: "Rate the bill's relevance to an association of New Jersey county clerks, based on their listed duties.",

  tagTaxonomy: [
    { name: 'Board of Elections', description: 'Bills affecting county boards of elections, their composition, duties, or procedures' },
    { name: 'Elections', description: 'Ballot design, Vote by Mail, candidate petitions, result certification, election administration generally' },
    { name: 'Land Records', description: 'Deed recording, mortgages, liens, land document filing and indexing' },
    { name: 'Court Administration', description: 'Superior Court support, court minutes, court records' },
    { name: 'Public Records', description: 'OPRA requests, access to government records, fees, exemptions, response timelines' },
    { name: 'Open Meetings', description: 'Open public meetings law, notice requirements, remote participation' },
    { name: 'County Clerk Functions', description: 'Passports, notary certification, trade names, military records, ID cards, and other clerk duties' },
    { name: 'Other', description: 'Subjects not captured in the above tags' },
  ],
}
