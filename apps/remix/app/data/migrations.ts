import path from 'node:path'
import type { Pool } from 'pg'
import { createPostgresDatabase } from 'remix/data-table/postgres'
import { loadMigrations } from 'remix/data-table/migrations/node'

export async function migrateDatabase(pool: Pool, options: { dryRun?: boolean; migrationsDirectory?: string } = {}) {
  let directory = options.migrationsDirectory ?? path.resolve(process.cwd(), 'db/migrations')
  let migrations = await loadMigrations(directory)
  // The Postgres driver reserves one connection for the advisory lock, journal
  // and migration transactions, and destroys that connection if a run fails.
  // The journal tracks which migrations have already been applied.
  return createPostgresDatabase(pool).migrate(migrations, {
    journalTable: 'remix_data_migrations',
    dryRun: options.dryRun,
  })
}
