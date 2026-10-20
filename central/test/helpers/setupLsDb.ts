import { legiscanMigrations, setupDb } from './migrations'

// Fresh LegiScan central DB with every migration in migrations/.
export async function setupLsDb(): Promise<void> {
  await setupDb(legiscanMigrations)
}
