import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'FloorVote',
  description: 'Legislative bill tracking for teams',
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/self-hosting' },
      { text: 'Architecture', link: '/architecture' },
      { text: 'GitHub', link: 'https://github.com/floorvote/floorvote' },
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Self-hosting', link: '/self-hosting' },
          { text: 'Adding tenants', link: '/spinning-up-instances' },
          { text: 'Presets', link: '/presets' },
        ],
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Overview', link: '/architecture' },
          { text: 'LegiScan API', link: '/legiscan-api-reference' },
        ],
      },
      {
        text: 'Features',
        items: [
          { text: 'Email digests', link: '/emails' },
          { text: 'Calendar (iCal)', link: '/ics-feed-capability-url' },
          { text: 'Turnstile login protection', link: '/turnstile-setup' },
        ],
      },
      {
        text: 'Contributing',
        items: [
          { text: 'Style tokens', link: '/style-token-decisions' },
          { text: 'Date/time convention', link: '/date-format-convention' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/floorvote/floorvote' },
    ],
    search: {
      provider: 'local',
    },
  },
})
