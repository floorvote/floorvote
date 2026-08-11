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
        bindings: {
          RESEND_API_KEY: 'test-key',
          GEMINI_API_KEY: 'test-gemini-key',
          APP_URL: 'http://localhost:5173',
          TENANT_ID: 'bpc-test',
          CENTRAL_API_URL: 'https://central.test',
          SUPERADMIN_JWT_PUBLIC_KEY: '{"key_ops":["verify"],"ext":true,"kty":"EC","x":"jMeKJ1Tf0sgE37Rzg02ARwUKvJ2hF6Zy2gI3mluSjpg","y":"vJ0-S0RvpYh3Z87ti61CrBjprBhpmiA4WujS6_Yb_lQ","crv":"P-256"}',
          CF_AIG_TOKEN: 'test-aig-token',
          CF_ACCOUNT_ID: 'test-account-id',
          CF_AIG_GATEWAY: 'tracker',
          AI_GATEWAY_ENABLED: 'false',
          OPERATOR_NAME: 'Test Operator',
          OPERATOR_URL: 'https://operator.test',
          OPERATOR_CONTACT_EMAILS: 'ops@example.test',
        },
      },
    }),
  ],
  test: {
    pool: cloudflarePool(),
    // Vitest's 5s default is too tight for this suite. The bulk-operation tests
    // seed 1,000+ bills to exercise the >1000 guard and the dismiss batching
    // boundary; they pass in under a second locally but have timed out at 7s and
    // 12s on contended CI runners, failing as "Test timed out in 5000ms" rather
    // than on any assertion. Raised rather than retried: these are duration
    // failures, not flake, so a real hang still fails, just later.
    testTimeout: 20_000,
  },
})
