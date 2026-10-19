import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'
import { cloudflarePool, cloudflareTest } from '@cloudflare/vitest-pool-workers'

// CI runs this suite in three shards (`--shard=n/3`, .github/workflows/ci.yml),
// and the run takes as long as the slowest one. Vitest's own split hashes each
// path and cuts the sorted list into equal file counts, so it ignores how long
// a file takes: on #813's run, one shard drew both of the two slowest files and
// took 5m19s while another took 2m36s (#804).
//
// These are the files that take about 10s or more on a CI runner. Each weight is
// the mean of its seconds on #813's CI run and twice its seconds on a laptop
// run (the laptop runs the whole suite about twice as fast), because the two
// machines rank these files differently and the split should hold on both.
// Together they are half the suite's time; every other file takes about 1.5s.
// A file left off this list still runs, it just counts as average. Add a file
// here when it starts to take 10s or more.
const HEAVY_FILE_SECONDS: Record<string, number> = {
  'test/routes/groupFacetsRandom2.test.ts': 139,
  'test/routes/groupFacetsRandom1.test.ts': 130,
  'test/lib/claimResolution.test.ts': 67,
  'test/routes/groupFacetsRandom4.test.ts': 45,
  'test/routes/filterInvariants.test.ts': 40,
  'test/lib/splitCannotLink.test.ts': 25,
  'test/routes/groupFacetsRandom3.test.ts': 25,
  'test/queue/processor-companion-analysis.test.ts': 19,
  'test/routes/groupFacets.test.ts': 18,
  'test/routes/groupFacetsRandom5.test.ts': 13,
  'test/routes/superadminProfileSignIn.test.ts': 13,
  'test/routes/billsApi.test.ts': 10,
}
const DEFAULT_FILE_SECONDS = 1.5

// Splits by estimated time rather than file count: heaviest first, each file
// to whichever shard has the least so far, ties in path order, so every shard
// computes the same split without coordinating. Within a shard, the heavy
// files start first so none of them begins near the end.
class TimeBalancedSequencer extends BaseSequencer {
  private seconds(spec: TestSpecification): number {
    const path = relative(this.ctx.config.root, spec.moduleId)
    return HEAVY_FILE_SECONDS[path] ?? DEFAULT_FILE_SECONDS
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!
    const ordered = files
      .map((spec) => ({ spec, path: relative(this.ctx.config.root, spec.moduleId) }))
      .sort((a, b) => this.seconds(b.spec) - this.seconds(a.spec) || (a.path < b.path ? -1 : 1))
    const load = new Array<number>(count).fill(0)
    const mine: TestSpecification[] = []
    for (const { spec } of ordered) {
      const lightest = load.indexOf(Math.min(...load))
      load[lightest] += this.seconds(spec)
      if (lightest === index - 1) mine.push(spec)
    }
    return mine
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files)
    return sorted.sort((a, b) => this.seconds(b) - this.seconds(a))
  }
}

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
          ALERT_EMAILS: 'ops@example.test',
        },
      },
    }),
  ],
  test: {
    pool: cloudflarePool(),
    sequence: { sequencer: TimeBalancedSequencer },
    // Stubs `fetch` with a guard that fails any test reaching the network.
    setupFiles: ['./test/setup.ts'],
    // Vitest's 5s default is too tight for this suite. The bulk-operation tests
    // seed 1,000+ bills to exercise the >1000 guard and the dismiss batching
    // boundary; they pass in under a second locally but have timed out at 7s and
    // 12s on contended CI runners, failing as "Test timed out in 5000ms" rather
    // than on any assertion. Raised rather than retried: these are duration
    // failures, not flake, so a real hang still fails, just later.
    testTimeout: 20_000,
  },
})
