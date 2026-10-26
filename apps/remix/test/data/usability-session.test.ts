import { randomUUID } from 'node:crypto'

import * as assert from 'remix/assert'
import { sql, type Database, type SqlStatement } from 'remix/data-table'
import { describe, it } from 'remix/test'

import {
  createDataRuntime,
  recordUsabilitySession,
  type UsabilitySessionRow,
} from '../../app/data/index.ts'
import { routes } from '../../app/routes.ts'

function sessionRow(
  id: string,
  viewport: Record<string, number>,
  device: Record<string, string>,
): UsabilitySessionRow {
  let now = new Date()
  return {
    id,
    auth_session_id: null,
    user_id: null,
    started_at: now,
    last_seen_at: now,
    ended_at: null,
    entry_path: routes.workspace.home.href(),
    referrer: '',
    user_agent: 'Desktop browser',
    device,
    initial_viewport: viewport,
    metadata: { source: 'test' },
  }
}

class RecordingDatabase {
  statement: SqlStatement | null = null

  async exec(statement: SqlStatement | string) {
    if (typeof statement === 'string') throw new Error('Expected parameterized SQL')
    this.statement = statement
    return { rows: [{}] }
  }
}

describe('usability session metadata', () => {
  it('guards both first-viewport fields with the persisted viewport', async () => {
    let db = new RecordingDatabase()
    await recordUsabilitySession(
      db as unknown as Database,
      sessionRow('session-1', { width: 390, height: 844 }, { deviceType: 'mobile' }),
    )

    let statement = db.statement?.text.replace(/\s+/g, ' ') ?? ''
    assert.match(
      statement,
      /device = case when usability_sessions\.initial_viewport = '\{\}'::jsonb and excluded\.initial_viewport <> '\{\}'::jsonb then excluded\.device/,
    )
    assert.match(
      statement,
      /initial_viewport = case when usability_sessions\.initial_viewport = '\{\}'::jsonb and excluded\.initial_viewport <> '\{\}'::jsonb then excluded\.initial_viewport/,
    )
  })

  it('fills the first viewport once without reclassifying later resizes', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let knownViewportId = randomUUID()
    let delayedViewportId = randomUUID()
    let wroteRows = false

    try {
      await recordUsabilitySession(runtime.db, sessionRow(
        knownViewportId,
        { width: 1440, height: 900 },
        { deviceType: 'desktop', platform: 'macos' },
      ))
      wroteRows = true
      await recordUsabilitySession(runtime.db, sessionRow(
        knownViewportId,
        { width: 390, height: 844 },
        { deviceType: 'mobile', platform: 'macos' },
      ))

      await recordUsabilitySession(runtime.db, sessionRow(
        delayedViewportId,
        {},
        { deviceType: 'desktop', platform: 'unknown' },
      ))
      await recordUsabilitySession(runtime.db, sessionRow(
        delayedViewportId,
        { width: 390, height: 844 },
        { deviceType: 'mobile', platform: 'unknown' },
      ))

      let result = await runtime.db.exec(sql`
        select id,device,initial_viewport
        from usability_sessions
        where id in (${knownViewportId},${delayedViewportId})
        order by id
      `)
      let rows = new Map((result.rows ?? []).map((row) => [String(row.id), row]))
      assert.deepEqual(rows.get(knownViewportId)?.device, { deviceType: 'desktop', platform: 'macos' })
      assert.deepEqual(rows.get(knownViewportId)?.initial_viewport, { width: 1440, height: 900 })
      assert.deepEqual(rows.get(delayedViewportId)?.device, { deviceType: 'mobile', platform: 'unknown' })
      assert.deepEqual(rows.get(delayedViewportId)?.initial_viewport, { width: 390, height: 844 })
    } finally {
      if (wroteRows) {
        await runtime.db.exec(sql`delete from usability_sessions where id=${knownViewportId}`)
        await runtime.db.exec(sql`delete from usability_sessions where id=${delayedViewportId}`)
      }
      await runtime.close()
    }
  })
})
