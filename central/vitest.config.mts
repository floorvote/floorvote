import { defineConfig } from 'vitest/config'
import { cloudflarePool, cloudflareTest } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      miniflare: {
        compatibilityDate: '2025-01-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        r2Buckets: ['BILLS_BUCKET'],
        queues: {
          producers: { INGESTOR_QUEUE: 'central-ingestor', NOTIFICATIONS_QUEUE: 'central-notifications' },
          consumers: ['central-ingestor'],
        },
        bindings: {
          LEGISCAN_API_KEY: 'test-key',
          OPENSTATES_API_KEY: 'test-openstates-key',
          ANTHROPIC_API_KEY: 'test-key',
          ADMIN_SECRET: 'test-secret',
          OPERATOR_NAME: 'TestOperator',
          BILL_PROVIDER: 'openstates',
        },
      },
    }),
  ],
  test: {
    pool: cloudflarePool(),
    exclude: ['web/**', 'node_modules/**'],
    // Vitest's 5s default is too tight for this suite. Several tests seed
    // hundreds of D1 rows to exercise chunking and pagination boundaries
    // ("batches sends in chunks of 100" inserts 250 bills), which runs in well
    // under a second locally but has blown 5s on a contended CI runner — a
    // timeout failure that reads as a broken test rather than a slow machine.
    // Raised rather than retried: these failures are duration, not flake, so a
    // real hang still fails, just later.
    testTimeout: 20_000,
  },
})
