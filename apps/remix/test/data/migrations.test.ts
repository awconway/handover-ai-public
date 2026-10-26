import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Pool } from 'pg'
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { migrateDatabase } from '../../app/data/migrations.ts'

const existingId = '20260901000000'
const pendingId = '20260910000000'
const existingSql = 'create table migration_example (id integer primary key);\n'
const pendingSql = 'alter table migration_example add column label text;\n'

async function migrationDirectory() {
  let directory = await fs.mkdtemp(path.join(os.tmpdir(), 'handover-remix-migrations-'))
  for (let [name, sql] of [
    [`${existingId}_existing`, existingSql],
    [`${pendingId}_pending`, pendingSql],
  ]) {
    let migration = path.join(directory, name)
    await fs.mkdir(migration)
    await fs.writeFile(path.join(migration, 'up.sql'), sql)
  }
  return directory
}

function recordingPool(options: { failMigration?: boolean; drift?: boolean } = {}) {
  let statements: Array<{ text: string; values: unknown[] }> = []
  let releases: Array<Error | boolean | undefined> = []
  let connections = 0
  let failure = new Error('Migration execution failed')
  let client = {
    // A pg PoolClient also has connect(); migrations must not call it again.
    async connect() { throw new Error('The reserved client was connected twice') },
    async query(text: string, values: unknown[] = []) {
      statements.push({ text, values })
      if (text.includes('pg_advisory_unlock')) return { rows: [{ released: true }], rowCount: 1 }
      if (/select id, name, checksum, batch, applied_at from remix_data_migrations/.test(text)) {
        return {
          rows: [{
            id: existingId,
            name: 'existing',
            checksum: createHash('sha256').update(options.drift ? 'old SQL' : existingSql).digest('hex'),
            batch: 4,
            applied_at: '2026-09-01T00:00:00.000Z',
          }],
          rowCount: 1,
        }
      }
      if (text === pendingSql && options.failMigration) throw failure
      return { rows: [], rowCount: 0 }
    },
    release(error?: Error | boolean) { releases.push(error) },
  }
  let pool = {
    async connect() { connections += 1; return client },
    async query() { throw new Error('Migration query escaped the reserved client') },
  } as unknown as Pool
  return { pool, statements, releases, failure, get connections() { return connections } }
}

describe('Postgres migration upgrade compatibility', () => {
  it('reuses the deployed journal and keeps the lock, SQL and journal write on one connection', async () => {
    let directory = await migrationDirectory()
    let f = recordingPool()
    try {
      let result = await migrateDatabase(f.pool, { migrationsDirectory: directory })

      assert.deepEqual(result.applied.map((entry) => entry.id), [pendingId])
      assert.deepEqual(result.sql, [pendingSql])
      assert.equal(f.connections, 1)
      assert.deepEqual(f.releases, [undefined])
      assert.ok(!f.statements.some((statement) => statement.text === existingSql))
      let journal = f.statements.find((statement) => statement.text.startsWith('insert into remix_data_migrations'))
      assert.ok(journal)
      assert.deepEqual(journal.values, [
        pendingId, 'pending', createHash('sha256').update(pendingSql).digest('hex'), 5,
      ])
      let text = f.statements.map((statement) => statement.text)
      let lock = text.findIndex((statement) => statement.includes('pg_advisory_lock('))
      let unlock = text.findIndex((statement) => statement.includes('pg_advisory_unlock('))
      assert.ok(lock < text.indexOf('begin'))
      assert.ok(text.indexOf('begin') < text.indexOf(pendingSql))
      assert.ok(text.indexOf(pendingSql) < text.indexOf(journal.text))
      assert.ok(text.indexOf(journal.text) < text.indexOf('commit'))
      assert.ok(text.indexOf('commit') < unlock)
      assert.deepEqual(f.statements[lock].values, ['remix_data_migrations'])
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('rolls back a failed migration and destroys its reserved connection', async () => {
    let directory = await migrationDirectory()
    let f = recordingPool({ failMigration: true })
    try {
      await assert.rejects(() => migrateDatabase(f.pool, { migrationsDirectory: directory }), /Migration execution failed/)
      assert.equal(f.connections, 1)
      assert.deepEqual(f.releases, [f.failure])
      let text = f.statements.map((statement) => statement.text)
      assert.ok(text.includes('rollback'))
      assert.ok(!text.includes('commit'))
      assert.ok(!text.some((statement) => statement.startsWith('insert into remix_data_migrations')))
      assert.ok(text.findIndex((statement) => statement.includes('pg_advisory_unlock(')) > text.indexOf('rollback'))
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('reports pending SQL in a dry run without changing schema or journal rows', async () => {
    let directory = await migrationDirectory()
    let f = recordingPool()
    try {
      let result = await migrateDatabase(f.pool, { migrationsDirectory: directory, dryRun: true })
      assert.deepEqual(result.sql, [pendingSql])
      assert.deepEqual(result.applied.map((entry) => entry.id), [pendingId])
      assert.ok(!f.statements.some((statement) => /^(create|alter|insert|delete|begin|commit)\b/i.test(statement.text)))
      assert.deepEqual(f.releases, [undefined])
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects changed migration checksums from the existing journal before applying pending SQL', async () => {
    let directory = await migrationDirectory()
    let f = recordingPool({ drift: true })
    try {
      await assert.rejects(() => migrateDatabase(f.pool, { migrationsDirectory: directory }), /checksum drift/)
      assert.ok(!f.statements.some((statement) => statement.text === pendingSql || statement.text === 'begin'))
      assert.equal(f.releases.length, 1)
      assert.ok(f.releases[0] instanceof Error)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
