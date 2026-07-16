import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'FloorVote',
  description: 'Legislative bill tracking for teams',
  base: '/docs/',
  srcDir: 'content',
  outDir: '.vitepress/dist/docs',
  themeConfig: {
    nav: [
      { text: 'Self-hosting', link: '/self-hosting/' },
      { text: 'Architecture', link: '/architecture/' },
      { text: 'GitHub', link: 'https://github.com/floorvote/floorvote' },
    ],
    sidebar: [
      {
        text: 'Features',
        items: [
          { text: 'Email digests', link: '/features/emails' },
          { text: 'Calendar (iCal)', link: '/features/calendar' },
          { text: 'Turnstile login protection', link: '/features/turnstile' },
        ],
      },
      {
        text: 'Self-hosting',
        items: [
          { text: 'Self-hosting', link: '/self-hosting/' },
          { text: 'Adding tenants', link: '/self-hosting/tenants' },
          { text: 'Presets', link: '/self-hosting/presets' },
        ],
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Overview', link: '/architecture/' },
          { text: 'LegiScan API', link: '/architecture/legiscan' },
        ],
      },
      {
        text: 'Contributing',
        items: [
          { text: 'Style tokens', link: '/contributing/style-tokens' },
          { text: 'Date/time convention', link: '/contributing/dates' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/floorvote/floorvote' },
    ],
    search: { provider: 'local' },
  },
})
