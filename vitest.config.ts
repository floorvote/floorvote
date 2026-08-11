import { defineConfig } from 'vitest/config'

/**
 * Root Vitest config — exists so that running `vitest` at the repo root does
 * the right thing instead of something actively misleading.
 *
 * There are four independent suites, each with its own environment: api and
 * central run in the Workers pool, web runs in jsdom with a setup file, and
 * scripts runs plain node. Without a root config, a bare `vitest run` here has
 * no configuration at all: it walks the whole tree, collects every `*.test.*`
 * it finds, and runs all of them in the default node environment. Web tests
 * then fail on `document is undefined`, Workers tests fail on missing bindings,
 * and you get ~450 failing files on a completely healthy checkout — a failure
 * mode that reads as "the repo is broken" rather than "wrong invocation".
 *
 * Listing the suites as projects makes each one load its own config, so the
 * root command is correct by construction. CI still runs the suites as
 * separate per-package jobs (see .github/workflows/ci.yml) because they
 * parallelize better that way and central installs its own dependencies; this
 * config is the local entry point, not a replacement for that.
 *
 * Note: `central` is not a root npm workspace, so its dependencies live in
 * central/node_modules. Run `npm ci --prefix central` once if the central
 * project fails to load here.
 */
export default defineConfig({
  test: {
    projects: [
      './api/vitest.config.mts',
      './central/vitest.config.mts',
      './web/vite.config.ts',
      './scripts/vitest.config.ts',
    ],
  },
})
