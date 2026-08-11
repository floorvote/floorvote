import { applyD1Migrations, env, reset } from 'cloudflare:test'
import migration0001 from '../../migrations-legiscan/0001_initial.sql?raw'
import migration0002 from '../../migrations-legiscan/0002_api_call_log_v2.sql?raw'
import migration0003 from '../../migrations-legiscan/0003_session_sync_log.sql?raw'
import migration0004 from '../../migrations-legiscan/0004_match_tracking.sql?raw'
import migration0005 from '../../migrations-legiscan/0005_bill_amendments_and_change_log.sql?raw'
import migration0006 from '../../migrations-legiscan/0006_texts_fetched_at.sql?raw'
import migration0007 from '../../migrations-legiscan/0007_admin_dashboard.sql?raw'
import migration0008 from '../../migrations-legiscan/0008_admin_sessions_name.sql?raw'
import migration0009 from '../../migrations-legiscan/0009_tenant_stats.sql?raw'
import migration0010 from '../../migrations-legiscan/0010_settings.sql?raw'
import migration0011 from '../../migrations-legiscan/0011_resend_usage_daily.sql?raw'
import migration0012 from '../../migrations-legiscan/0012_tenant_stats_probe.sql?raw'
import migration0013 from '../../migrations-legiscan/0013_tenants_queue_id.sql?raw'
import migration0014 from '../../migrations-legiscan/0014_tenant_stats_excluded.sql?raw'
// 0015 is an index-only migration and is intentionally skipped here. 0016 is
// required: it adds bill_texts.fetch_error, which the drizzle schema now writes
// on every insert, so omitting it breaks any test that touches bill_texts.
import migration0016 from '../../migrations-legiscan/0016_bill_texts_fetch_error.sql?raw'

function parseMigration(sql: string, name: string) {
  const queries = sql
    .split(';')
    .map(s => s.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n').trim())
    .filter(s => s.length > 0)
    .map(s => s + ';')
  return { name, queries }
}

export async function setupLsDb(): Promise<void> {
  await reset()
  await applyD1Migrations(env.DB, [
    parseMigration(migration0001, '0001_initial'),
    parseMigration(migration0002, '0002_api_call_log_v2'),
    parseMigration(migration0003, '0003_session_sync_log'),
    parseMigration(migration0004, '0004_match_tracking'),
    parseMigration(migration0005, '0005_bill_amendments_and_change_log'),
    parseMigration(migration0006, '0006_texts_fetched_at'),
    parseMigration(migration0007, '0007_admin_dashboard'),
    parseMigration(migration0008, '0008_admin_sessions_name'),
    parseMigration(migration0009, '0009_tenant_stats'),
    parseMigration(migration0010, '0010_settings'),
    parseMigration(migration0011, '0011_resend_usage_daily'),
    parseMigration(migration0012, '0012_tenant_stats_probe'),
    parseMigration(migration0013, '0013_tenants_queue_id'),
    parseMigration(migration0014, '0014_tenant_stats_excluded'),
    parseMigration(migration0016, '0016_bill_texts_fetch_error'),
  ])
}
