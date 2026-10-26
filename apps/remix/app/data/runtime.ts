import { Pool, type PoolConfig } from 'pg'
import type { Database } from 'remix/data-table'
import { createPostgresDatabase } from 'remix/data-table/postgres'

export type DataRuntime = {
  pool: Pool
  db: Database
  ready(): Promise<void>
  close(): Promise<void>
}

export function createDataRuntime(options: { connectionString?: string; pool?: Pool; poolConfig?: PoolConfig } = {}): DataRuntime {
  let ownsPool = options.pool == null
  let pool = options.pool ?? new Pool({
    connectionString: options.connectionString ?? process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    ...options.poolConfig,
  })
  let db = createPostgresDatabase(pool)

  return {
    pool,
    db,
    async ready() {
      await db.exec('select 1')
    },
    async close() {
      if (ownsPool) await pool.end()
    },
  }
}
