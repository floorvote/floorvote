import { defineConfig, normalizePath } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'path'
import { PRODUCT_NAME } from '../shared/brand'
import { colorVariablesCss } from './src/styles/colorModes'

// Vite gives module ids forward slashes on every OS, so these are compared in
// that form too. Built with backslashes, the Windows build never matched and
// shipped the literal palette, which ignores dark mode.
const sharedDir = normalizePath(path.resolve(__dirname, '../shared')) + '/'
const sharedTokens = normalizePath(path.resolve(__dirname, '../shared/tokens.ts'))
const webTokens = path.resolve(__dirname, 'src/styles/tokens.ts')

export default defineConfig({
  plugins: [
    react(),
    {
      // Keep the static <title> single-sourced from shared/brand.ts.
      name: 'inject-product-name',
      transformIndexHtml: (html) => html.replaceAll('%PRODUCT_NAME%', PRODUCT_NAME),
    },
    {
      // Both color modes as CSS variables, inline in the HTML shell so they
      // apply before the first paint (see src/styles/colorModes.ts). 'pre', so
      // the placeholder is replaced before the build minifies inline CSS.
      name: 'color-variables',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html.replace('/* %COLOR_VARIABLES% */', colorVariablesCss()),
      },
    },
    {
      // Shared modules (chip colors, event lines, mention pills, the wordmark)
      // import the literal palette from shared/tokens.ts because the API's emails
      // use them too. In the web build they get the CSS-variable tokens instead,
      // so they follow the color mode like everything else.
      name: 'shared-tokens-as-variables',
      enforce: 'pre',
      async resolveId(source, importer) {
        if (!importer || !normalizePath(importer).startsWith(sharedDir) || !/(^|\/)tokens(\.ts)?$/.test(source)) return null
        const resolved = await this.resolve(source, importer, { skipSelf: true })
        return resolved && normalizePath(resolved.id) === sharedTokens ? webTokens : null
      },
    },
    {
      // Expose the operator's legal docs as `virtual:legal-docs`, read with Node
      // fs at build time. Reliable for the repo-root docs/legal/ dir in both dev
      // and the rolldown production build — unlike an outside-root
      // `import.meta.glob`, which the production build silently drops. Real-named
      // files are gitignored until launch; absent files resolve to null, so no
      // /terms or /privacy routes and no footer/login legal links render.
      name: 'legal-docs',
      resolveId(id) {
        if (id === 'virtual:legal-docs') return '\0virtual:legal-docs'
      },
      load(id) {
        if (id !== '\0virtual:legal-docs') return
        const dir = path.resolve(__dirname, '../docs/legal')
        const read = (name) => {
          try { return fs.readFileSync(path.join(dir, name), 'utf8') } catch { return null }
        }
        const terms = read('TERMS OF USE.md')
        const privacy = read('PRIVACY POLICY.md')
        return `export const terms = ${JSON.stringify(terms)}\nexport const privacy = ${JSON.stringify(privacy)}\n`
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        // Defaults to the hosted demo; `npm run dev:local` sets VITE_API_PROXY
        // to http://localhost:8787 so the SPA hits the local tenant Worker.
        target: process.env.VITE_API_PROXY ?? 'https://demo.example.com',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            const cookies = proxyRes.headers['set-cookie']
            if (cookies) {
              proxyRes.headers['set-cookie'] = cookies.map((c) =>
                c.replace(/;\s*Secure/gi, '').replace(/;\s*SameSite=\w+/gi, '; SameSite=Lax'),
              )
            }
          })
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // jsdom UI tests parallelize heavily on CI; a contended runner can occasionally
    // starve an async render past its wait, flaking a correct test. Retry absorbs
    // these infra flakes — the structural fixes (deferred mocks, re-queried nodes,
    // raised async timeout) keep the base rate low, so a real failure still fails
    // all attempts.
    retry: 2,
    include: ['src/**/*.{test,spec}.?(c|m)[jt]s?(x)', '../shared/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  },
})
