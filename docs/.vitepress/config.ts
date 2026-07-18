import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(
  defineConfig({
  title: 'FloorVote',
  description: 'Bill tracking for teams',
  base: '/docs/',
  srcDir: 'content',
  outDir: '.vitepress/dist/docs',
  themeConfig: {
    sidebar: [
      {
        text: 'Should I use FloorVote?',
        items: [
          { text: 'What can it do?', link: '/overview/what-can-it-do' },
          { text: 'How much does it cost?', link: '/overview/how-much-does-it-cost' },
          { text: 'How hard is it to set up?', link: '/overview/how-hard-is-it-to-set-up' },
        ],
      },
      {
        text: 'Set up',
        items: [
          { text: 'Self-hosting', link: '/self-hosting/' },
          { text: 'Adding tenants', link: '/self-hosting/tenants' },
        ],
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Overview', link: '/architecture/' },
        ],
      },
      {
        text: 'Contributing',
        items: [
          { text: 'Contributing', link: '/contributing/' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/floorvote/floorvote' },
    ],
    search: { provider: 'local' },
  },
  }),
)
