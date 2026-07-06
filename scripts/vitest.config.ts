import { defineConfig } from 'vitest/config'

// Vitest config for the scripts/ utility code. Uses Node environment (not the
// Cloudflare Workers pool that central/api use) because these scripts run
// locally via tsx and call out to wrangler subprocesses.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
})
