import { EventEmitter } from 'node:events'

import type { Notification } from 'pg'
import * as assert from 'remix/assert'
import type { Database, SqlStatement } from 'remix/data-table'
import { describe, it } from 'remix/test'

import {
  createHandoverProcessingChanges,
  HANDOVER_PROCESSING_CHANNEL,
  notifyHandoverProcessingChanged,
} from '../../app/data/handover-processing-events.ts'

class RecordingDatabase {
  statement: SqlStatement | null = null
  async exec(statement: SqlStatement | string) {
    if (typeof statement !== 'string') this.statement = statement
    return { rows: [] }
  }
}

class FakeClient extends EventEmitter {
  queries: string[] = []
  ended = false
  async connect() {}
  async query(statement: string) { this.queries.push(statement); return { rows: [] } }
  async end() { this.ended = true }
}

describe('handover processing notifications', () => {
  it('emits a parameterized notification from the caller transaction', async () => {
    let db = new RecordingDatabase()
    await notifyHandoverProcessingChanged(db as unknown as Database, 'handover-1')
    assert.match(db.statement?.text ?? '', /select pg_notify/)
    assert.deepEqual(db.statement?.values, [HANDOVER_PROCESSING_CHANNEL, 'handover-1'])
  })

  it('fans valid notifications out through one dedicated listener', async () => {
    let client = new FakeClient()
    let changes = createHandoverProcessingChanges({}, { createClient: () => client })
    let received: Array<string | null> = []
    let unsubscribe = changes.subscribe((handoverId) => received.push(handoverId))
    await changes.start()

    client.emit('notification', {
      processId: 1, channel: HANDOVER_PROCESSING_CHANNEL, payload: 'handover-1',
    } satisfies Notification)
    client.emit('notification', {
      processId: 1, channel: HANDOVER_PROCESSING_CHANNEL, payload: 'not valid!',
    } satisfies Notification)

    assert.deepEqual(received, [null, 'handover-1'])
    unsubscribe()
    await changes.close()
    assert.deepEqual(client.queries, [
      `listen ${HANDOVER_PROCESSING_CHANNEL}`,
      `unlisten ${HANDOVER_PROCESSING_CHANNEL}`,
    ])
    assert.equal(client.ended, true)
  })
})
