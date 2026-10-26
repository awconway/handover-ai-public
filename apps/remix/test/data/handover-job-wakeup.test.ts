import { EventEmitter } from 'node:events'

import type { Notification } from 'pg'
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import type { Database, SqlStatement } from 'remix/data-table'

import {
  createHandoverJobQueueWakeup,
  HANDOVER_JOB_QUEUE_CHANNEL,
  notifyHandoverJobQueued,
} from '../../app/data/handover-job-wakeup.ts'
import { createDataRuntime } from '../../app/data/runtime.ts'

class RecordingDatabase {
  statement: SqlStatement | null = null

  async exec(statement: SqlStatement | string) {
    if (typeof statement !== 'string') this.statement = statement
    return { rows: [] }
  }
}

class FakeListenerClient extends EventEmitter {
  queries: string[] = []
  ended = false
  setupFailure: 'error' | 'end' | null

  constructor(setupFailure: 'error' | 'end' | null = null) {
    super()
    this.setupFailure = setupFailure
  }

  async connect() {}

  async query(statement: string) {
    this.queries.push(statement)
    if (statement === `listen ${HANDOVER_JOB_QUEUE_CHANNEL}` && this.setupFailure) {
      if (this.setupFailure === 'end') this.ended = true
      this.emit(this.setupFailure, ...(this.setupFailure === 'error' ? [new Error('setup failed')] : []))
    }
    return { rows: [] }
  }

  async end() {
    this.ended = true
  }
}

class FakeListenerFactory {
  clients: FakeListenerClient[] = []
  setupFailures: Array<'error' | 'end' | null>

  constructor(setupFailures: Array<'error' | 'end' | null> = []) {
    this.setupFailures = setupFailures
  }

  createClient = () => {
    let client = new FakeListenerClient(this.setupFailures.shift() ?? null)
    this.clients.push(client)
    return client
  }
}

function fakeWakeup(factory: FakeListenerFactory, options: { reconnectMs?: number; onUnavailable?: (error: unknown) => void } = {}) {
  return createHandoverJobQueueWakeup({}, { ...options, createClient: factory.createClient })
}

function notification(): Notification {
  return { processId: 1, channel: HANDOVER_JOB_QUEUE_CHANNEL, payload: 'job-1' }
}

describe('handover job queue wake-up', () => {
  it('emits a parameterized PostgreSQL notification through the enqueue transaction', async () => {
    let db = new RecordingDatabase()
    await notifyHandoverJobQueued(db as unknown as Database, 'job-1')

    assert.match(db.statement?.text ?? '', /select pg_notify/)
    assert.deepEqual(db.statement?.values, [HANDOVER_JOB_QUEUE_CHANNEL, 'job-1'])
  })

  it('wakes an active wait and releases its dedicated listener on close', async () => {
    let factory = new FakeListenerFactory()
    let wakeup = fakeWakeup(factory)
    await wakeup.start()

    let waiting = wakeup.wait(1_000)
    factory.clients[0]!.emit('notification', notification())
    assert.equal(await waiting, 'notified')

    await wakeup.close()
    assert.deepEqual(factory.clients[0]!.queries, [
      `listen ${HANDOVER_JOB_QUEUE_CHANNEL}`,
      `unlisten ${HANDOVER_JOB_QUEUE_CHANNEL}`,
    ])
    assert.equal(factory.clients[0]!.ended, true)
  })

  it('keeps timed polling as the fallback and reconnects a failed listener', async () => {
    let factory = new FakeListenerFactory()
    let unavailable = 0
    let wakeup = fakeWakeup(factory, {
      reconnectMs: 5,
      onUnavailable() { unavailable++ },
    })
    await wakeup.start()

    let first = factory.clients[0]!
    first.emit('error', new Error('connection lost'))
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.equal(unavailable, 1)
    assert.equal(first.ended, true)
    assert.equal(factory.clients.length, 2)
    assert.equal(await wakeup.wait(5), 'timeout')

    let waiting = wakeup.wait(1_000)
    factory.clients[1]!.emit('notification', notification())
    assert.equal(await waiting, 'notified')
    await wakeup.close()
  })

  it('resolves an active wait and cancels reconnect work during shutdown', async () => {
    let factory = new FakeListenerFactory()
    let wakeup = fakeWakeup(factory, { reconnectMs: 5 })
    await wakeup.start()
    let waiting = wakeup.wait(1_000)

    factory.clients[0]!.emit('error', new Error('connection lost'))
    let firstClose = wakeup.close()
    let secondClose = wakeup.close()

    assert.equal(await waiting, 'closed')
    await Promise.all([firstClose, secondClose])
    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.equal(factory.clients.length, 1)
  })

  it('never installs a candidate invalidated during LISTEN setup', async () => {
    for (let setupFailure of ['error', 'end'] as const) {
      let factory = new FakeListenerFactory([setupFailure, null])
      let wakeup = fakeWakeup(factory, { reconnectMs: 5 })
      await wakeup.start()
      await new Promise((resolve) => setTimeout(resolve, 20))

      assert.equal(factory.clients.length, 2)
      assert.equal(factory.clients[0]!.ended, true)
      let staleWait = wakeup.wait(5)
      factory.clients[0]!.emit('notification', notification())
      assert.equal(await staleWait, 'timeout')

      let activeWait = wakeup.wait(1_000)
      factory.clients[1]!.emit('notification', notification())
      assert.equal(await activeWait, 'notified')
      await wakeup.close()
    }
  })

  it('does not deliver a transactional notification until commit', async () => {
    if (!process.env.DATABASE_URL) return
    let listenerRuntime = createDataRuntime()
    let writerRuntime = createDataRuntime()
    let wakeup = createHandoverJobQueueWakeup(listenerRuntime.pool.options)
    let releaseTransaction = () => {}
    let transactionGate = new Promise<void>((resolve) => { releaseTransaction = resolve })
    let notifiedInsideTransaction = () => {}
    let transactionReady = new Promise<void>((resolve) => { notifiedInsideTransaction = resolve })

    try {
      await listenerRuntime.ready()
      await writerRuntime.ready()
      await wakeup.start()
      let transaction = writerRuntime.db.transaction(async (tx) => {
        await notifyHandoverJobQueued(tx, 'transactional-job')
        notifiedInsideTransaction()
        await transactionGate
      })
      await transactionReady

      assert.equal(await wakeup.wait(25), 'timeout')
      releaseTransaction()
      await transaction
      assert.equal(await wakeup.wait(1_000), 'notified')
    } finally {
      releaseTransaction()
      await wakeup.close()
      await listenerRuntime.close()
      await writerRuntime.close()
    }
  })

  it('does not consume the operational pool connection when the pool maximum is one', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime({ poolConfig: { max: 1 } })
    let wakeup = createHandoverJobQueueWakeup(runtime.pool.options)
    try {
      await runtime.ready()
      await wakeup.start()
      let result = await Promise.race([
        runtime.db.exec('select 1 as available'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Operational pool was starved by LISTEN.')), 500)),
      ])
      assert.equal(result.rows?.[0]?.available, 1)
      assert.equal(runtime.pool.totalCount, 1)
    } finally {
      await wakeup.close()
      await runtime.close()
    }
  })
})
