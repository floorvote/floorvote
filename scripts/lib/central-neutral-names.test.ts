// Central's provider-neutral names (#393): `src/index.ts`, `migrations/`, and
// the `*:central` npm scripts, with the LegiScan-named ones kept as aliases so a
// self-hoster's gitignored `central/wrangler.toml` and habits keep working.
//
// Three seams: the two migrations folders hold the same files, every npm script
// runs the same commands it did before, and wrangler itself sees the same
// migrations and builds the same worker through either set of names.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(__dirname, '../..')
const CENTRAL = join(ROOT, 'central')
const NEUTRAL_DIR = join(CENTRAL, 'migrations')
const LEGACY_DIR = join(CENTRAL, 'migrations-legiscan')

// Every central migration that existed when the neutral names arrived. D1
// records an applied migration by its filename, so renaming any of these would
// make an already-migrated database apply it a second time.
const MIGRATIONS_AT_RENAME = [
  '0001_initial.sql', '0002_api_call_log_v2.sql', '0003_session_sync_log.sql', '0004_match_tracking.sql',
  '0005_bill_amendments_and_change_log.sql', '0006_texts_fetched_at.sql', '0007_admin_dashboard.sql',
  '0008_admin_sessions_name.sql', '0009_tenant_stats.sql', '0010_settings.sql', '0011_resend_usage_daily.sql',
  '0012_tenant_stats_probe.sql', '0013_tenants_queue_id.sql', '0014_tenant_stats_excluded.sql',
  '0015_bill_calendar_date_idx.sql', '0016_bill_texts_fetch_error.sql', '0017_tenant_ai_personalized.sql',
  '0018_tenant_stats_ai_stalled.sql', '0019_tenant_stats_ai_stalled_oldest.sql', '0020_legiscan_limit_10k.sql',
  '0021_lims_records.sql', '0021_session_votes_dataset.sql', '0025_source_provenance.sql', '0026_source_ids.sql',
  '0027_provider_column.sql', '0028_provider_record_details.sql', '0029_drop_lims_records.sql',
  '0030_state_providers.sql', '0031_session_slugs.sql', '0032_bill_extras.sql', '0033_bill_history_video.sql',
  '0034_bill_calendar_identity.sql', '0035_committee_provider.sql', '0036_cutovers.sql', '0037_body_events.sql',
  '0038_session_snapshot_etag.sql', '0039_superadmin_profiles.sql', '0040_texts_requested_at.sql',
  '0041_bill_detail_refresh.sql', '0042_provider_cache.sql', '0043_bill_sasts_companion_index.sql',
  '0044_call_log_indexes.sql', '0045_session_sync_log_status.sql', '0046_bill_tenant_fetch_requests.sql',
  '0048_bill_first_ingest_tries.sql', '0049_bill_first_ingest_queued_at.sql',
]

function sqlFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
}

describe('central migrations folders', () => {
  it('keeps migrations/ as the real folder and migrations-legiscan as a relative symlink to it', () => {
    expect(existsSync(NEUTRAL_DIR) && lstatSync(NEUTRAL_DIR).isDirectory()).toBe(true)
    expect(existsSync(LEGACY_DIR) && lstatSync(LEGACY_DIR).isSymbolicLink()).toBe(true)
    // Relative, so the link resolves in any clone. A per-file symlink would not
    // do: wrangler skips directory entries that aren't plain files.
    expect(readlinkSync(LEGACY_DIR)).toBe('migrations')
    expect(realpathSync(LEGACY_DIR)).toBe(realpathSync(NEUTRAL_DIR))
  })

  it('lists the same migration files, byte for byte, in both folders', () => {
    const neutral = sqlFiles(NEUTRAL_DIR)
    const legacy = sqlFiles(LEGACY_DIR)
    expect(neutral.length).toBeGreaterThan(0)
    expect(legacy).toEqual(neutral)
    for (const file of neutral) {
      expect(readFileSync(join(LEGACY_DIR, file), 'utf8'), file).toBe(readFileSync(join(NEUTRAL_DIR, file), 'utf8'))
    }
  })

  it('keeps every migration filename that existed at the rename', () => {
    const neutral = sqlFiles(NEUTRAL_DIR)
    expect(MIGRATIONS_AT_RENAME.filter(f => !neutral.includes(f))).toEqual([])
  })
})

// --- npm scripts --------------------------------------------------------------

type Scripts = Record<string, string>

function centralScripts(): Scripts {
  return JSON.parse(readFileSync(join(CENTRAL, 'package.json'), 'utf8')).scripts
}

// The commands `npm run <name>` ends up running, in order: its pre hook, each
// `&&` step (following `npm run <script>` into central's own scripts), and its
// post hook. A step that changes directory runs another package's scripts, so
// it is kept whole.
function leafCommands(scripts: Scripts, name: string, depth = 0): string[] {
  if (depth > 10) throw new Error(`npm script loop at ${name}`)
  const body = scripts[name]
  if (body === undefined) throw new Error(`no npm script named ${name}`)
  const own = body.includes('cd ')
    ? [body]
    : body.split('&&').map(s => s.trim()).flatMap(step => {
      const m = /^npm run ([\w:.-]+)$/.exec(step)
      return m && scripts[m[1]] !== undefined ? leafCommands(scripts, m[1], depth + 1) : [step]
    })
  const hook = (h: string) => (scripts[h] !== undefined ? leafCommands(scripts, h, depth + 1) : [])
  return [...hook(`pre${name}`), ...own, ...hook(`post${name}`)]
}

const BUILD_WEB = 'cd web && npm install && npm run build'
const MIGRATE_REMOTE = 'wrangler d1 migrations apply central-bills-ls --remote --env legiscan'
const MIGRATE_LOCAL = 'wrangler d1 migrations apply central-bills-ls --local --env legiscan'
const DEPLOY = 'wrangler deploy --env legiscan'
// No inline SMOKE_BASE_URL: the smoke check reads it from the environment, so a
// fork can set it (or blank it) inline on its own copy of the script.
const SMOKE = 'node scripts/smoke-text.mjs'
const BACKUP = 'bash scripts/backup-config.sh'
const FULL_DEPLOY = [BUILD_WEB, MIGRATE_REMOTE, DEPLOY, SMOKE, BACKUP]

// What each LegiScan-named script (and its generic alias) ran before #393.
const BEFORE: Record<string, string[]> = {
  'deploy': FULL_DEPLOY,
  'deploy:legiscan': FULL_DEPLOY,
  'postdeploy:legiscan': [BACKUP],
  'smoke:legiscan': [SMOKE],
  'migrate:local': [MIGRATE_LOCAL],
  'migrate:remote': [MIGRATE_REMOTE],
  'migrate:legiscan:local': [MIGRATE_LOCAL],
  'migrate:legiscan:remote': [MIGRATE_REMOTE],
}

describe('central npm scripts', () => {
  it.each(Object.entries(BEFORE))('npm run %s still runs the commands it ran before', (name, before) => {
    expect(leafCommands(centralScripts(), name)).toEqual(before)
  })

  it.each([
    ['deploy:central', 'deploy:legiscan'],
    ['migrate:central:remote', 'migrate:legiscan:remote'],
    ['migrate:central:local', 'migrate:legiscan:local'],
    ['smoke:central', 'smoke:legiscan'],
  ])('npm run %s runs what npm run %s runs', (neutral, legacy) => {
    const scripts = centralScripts()
    expect(scripts[neutral], `${neutral} exists`).toBeDefined()
    expect(leafCommands(scripts, neutral)).toEqual(BEFORE[legacy])
  })

  it('backs up the config once per deploy, whichever name runs it', () => {
    const scripts = centralScripts()
    for (const name of ['deploy', 'deploy:legiscan', 'deploy:central']) {
      expect(scripts[name], `${name} exists`).toBeDefined()
      expect(leafCommands(scripts, name).filter(c => c === BACKUP), name).toHaveLength(1)
    }
  })
})

// --- example config, docs, and helpers -----------------------------------------

const OLD_NAME = /deploy:legiscan|migrate:legiscan|smoke:legiscan|postdeploy:legiscan|index-legiscan|migrations-legiscan/

describe('operator-facing config and docs', () => {
  it('names the neutral entry file and migrations folder in wrangler.example.toml', () => {
    const example = readFileSync(join(CENTRAL, 'wrangler.example.toml'), 'utf8')
    expect(example).toMatch(/^main = "src\/index\.ts"$/m)
    expect(example).toMatch(/^migrations_dir = "migrations"$/m)
  })

  // A line may still name an old one to say it is an alias.
  it('uses only the neutral names in the self-hosting docs, AGENTS.md, helper scripts, and deploy workflow', () => {
    const files = [
      'central/wrangler.example.toml',
      'AGENTS.md',
      'docs/content/self-hosting/index.md',
      'docs/content/self-hosting/operating.md',
      'docs/content/self-hosting/tenants.md',
      'docs/content/self-hosting/demo.md',
      'scripts/new-instance.sh',
      'scripts/teardown-instance.sh',
      '.github/workflows/deploy.yml',
    ]
    const offenders = files.flatMap(file => readFileSync(join(ROOT, file), 'utf8').split('\n')
      .map((line, i) => ({ line, at: `${file}:${i + 1}` }))
      .filter(({ line }) => OLD_NAME.test(line) && !/alias/i.test(line))
      .map(({ at, line }) => `${at}: ${line.trim()}`))
    expect(offenders).toEqual([])
  })

  it('has a release note telling operators to switch their wrangler.toml', () => {
    const note = readFileSync(join(ROOT, 'docs/internal/release-notes-next.md'), 'utf8')
    expect(note).toContain('main = "src/index.ts"')
    expect(note).toContain('migrations_dir = "migrations"')
    expect(note).toContain('npm run deploy:central')
  })
})

// --- wrangler rehearsal -------------------------------------------------------

// Wrangler from the root install, which the scripts suite's CI job has. It
// resolves central's imports up the tree, so central's own install isn't needed.
const WRANGLER = join(ROOT, 'node_modules/wrangler/bin/wrangler.js')

function wranglerConfig(main: string, migrationsDir: string): string {
  // Absolute paths, so the config can live in a temp dir and still name
  // central's files exactly as central/wrangler.toml does.
  return [
    'name = "rehearsal-central"',
    `main = "${join(CENTRAL, main)}"`,
    'compatibility_date = "2026-06-18"',
    'compatibility_flags = ["nodejs_compat"]',
    '[[d1_databases]]',
    'binding = "DB"',
    'database_name = "central-bills-ls"',
    'database_id = "00000000-0000-4000-8000-000000000393"',
    `migrations_dir = "${join(CENTRAL, migrationsDir)}"`,
    '',
  ].join('\n')
}

describe('a local deploy rehearsal with wrangler', () => {
  let tmp: string
  let oldConfig: string
  let neutralConfig: string

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'central-neutral-names-'))
    oldConfig = join(tmp, 'old.toml')
    neutralConfig = join(tmp, 'neutral.toml')
    writeFileSync(oldConfig, wranglerConfig('src/index-legiscan.ts', 'migrations-legiscan'))
    writeFileSync(neutralConfig, wranglerConfig('src/index.ts', 'migrations'))
  })
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }) })

  function wrangler(args: string[]): { status: number | null; out: string } {
    const r = spawnSync(process.execPath, [WRANGLER, ...args], {
      cwd: tmp,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(tmp, 'logs'), NO_COLOR: '1' },
      timeout: 120_000,
    })
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
  }

  // The migration names wrangler's table lists, in order.
  const pending = (out: string) => [...out.matchAll(/│ (\d{4}_\S+\.sql) /g)].map(m => m[1])

  function migrations(command: 'list' | 'apply', config: string, persist: string) {
    const r = wrangler(['d1', 'migrations', command, 'central-bills-ls', '--local', '-c', config, '--persist-to', join(tmp, persist)])
    expect(r.status, r.out).toBe(0)
    return r.out
  }

  it('sees the same migrations through either folder, and a database migrated through one has nothing to apply through the other', () => {
    const files = sqlFiles(NEUTRAL_DIR)
    expect(files.length).toBeGreaterThan(0)
    expect(pending(migrations('list', oldConfig, 'fresh'))).toEqual(files)
    expect(pending(migrations('list', neutralConfig, 'fresh'))).toEqual(files)

    // An existing self-hoster's database, migrated under the old config.
    migrations('apply', oldConfig, 'old')
    for (const config of [neutralConfig, oldConfig]) {
      const out = migrations('list', config, 'old')
      expect(pending(out)).toEqual([])
      expect(out).toContain('No migrations to apply')
    }

    // A new self-hoster's database, migrated under the neutral config.
    migrations('apply', neutralConfig, 'neutral')
    for (const config of [oldConfig, neutralConfig]) {
      const out = migrations('list', config, 'neutral')
      expect(pending(out)).toEqual([])
      expect(out).toContain('No migrations to apply')
    }
  }, 300_000)

  it('builds the same worker from either entry file', () => {
    function build(config: string, name: string) {
      const outdir = join(tmp, `build-${name}`)
      const r = wrangler(['deploy', '--dry-run', '-c', config, '--outdir', outdir, '--metafile', join(outdir, 'meta.json')])
      expect(r.status, r.out).toBe(0)
      const meta = JSON.parse(readFileSync(join(outdir, 'meta.json'), 'utf8')) as {
        inputs: Record<string, unknown>
        outputs: Record<string, { exports?: string[]; entryPoint?: string }>
      }
      const entry = Object.values(meta.outputs).find(o => o.entryPoint)
      return { inputs: Object.keys(meta.inputs).sort(), exports: [...(entry?.exports ?? [])].sort() }
    }
    const neutral = build(neutralConfig, 'neutral')
    const old = build(oldConfig, 'old')

    expect(neutral.exports).toEqual(expect.arrayContaining(['default', 'TenantApi', 'StatsApi']))
    expect(old.exports).toEqual(neutral.exports)
    // The old entry adds only itself: the re-export file, around the same modules.
    expect(old.inputs.filter(i => !neutral.inputs.includes(i)).map(i => i.split('/').pop())).toEqual(['index-legiscan.ts'])
    expect(neutral.inputs.filter(i => !old.inputs.includes(i))).toEqual([])
  }, 300_000)
})
