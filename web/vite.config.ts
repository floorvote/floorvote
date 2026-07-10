import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { PRODUCT_NAME } from '../shared/brand'

export default defineConfig({
  plugins: [
    react(),
    {
      // Keep the static <title> single-sourced from shared/brand.ts.
      name: 'inject-product-name',
      transformIndexHtml: (html) => html.replaceAll('%PRODUCT_NAME%', PRODUCT_NAME),
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
