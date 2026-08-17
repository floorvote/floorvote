import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(
  defineConfig({
    title: 'FloorVote',
    description: 'Bill tracking for teams',
    base: '/docs/',
    srcDir: 'content',
    outDir: '.vitepress/dist/docs',
    head: [
      ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
      ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
      ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Archivo:wght@600;800&display=swap' }],
      ['link', { rel: 'icon', type: 'image/svg+xml', href: '/docs/favicon.svg' }],
      ['link', { rel: 'icon', href: '/docs/favicon.ico', sizes: '48x48' }],
      ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: '/docs/apple-touch-icon.png' }],
    ],
    themeConfig: {
      siteTitle: false,
      logoLink: 'https://floorvote.org/',
      sidebar: [
        {
          text: 'Is FloorVote for me?',
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
            {
              text: 'Optional',
              collapsed: false,
              items: [
                { text: 'Operating', link: '/self-hosting/operating' },
                { text: 'Turnstile', link: '/self-hosting/turnstile' },
                { text: 'Public demo site', link: '/self-hosting/demo' },
              ],
            },
          ],
        },
        // Flat top-level links — each of these is a single page, so a section
        // wrapper would add a heading with one child under it.
        { text: 'Architecture', link: '/architecture/' },
        { text: 'Contributing', link: '/contributing/' },
        { text: 'Security', link: '/security/' },
      ],
      socialLinks: [
        { icon: 'github', link: 'https://github.com/floorvote/floorvote' },
      ],
      search: { provider: 'local' },
    },
  }),
)
