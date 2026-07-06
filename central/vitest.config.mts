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
  },
})
