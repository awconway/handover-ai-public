import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { sql, type Database, type SqlStatement } from 'remix/data-table'

import {
  consumeProvisionalAudioUploadCleanupInTransaction,
  enqueueProvisionalAudioUploadCleanup,
  enqueueResourceCleanupIfEligibleInTransaction,
  enqueueResourceCleanupInTransaction,
  type EnqueueResourceCleanupInput,
  LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
  lockAudioBlobKeyForReferenceAssignment,
  ResourceCleanupConflictError,
} from '../../app/data/resource-cleanup.ts'
import { createDataRuntime } from '../../app/data/runtime.ts'

function enqueueCleanup(db: Database, input: EnqueueResourceCleanupInput) {
  return db.transaction((tx) => enqueueResourceCleanupInTransaction(tx, input))
}

class GenericCleanupDatabase {
  statements: SqlStatement[] = []
  inTransaction = false
  conflict = false
  cleanupRow: Record<string, unknown> | null = null

  async transaction<T>(callback: (db: Database) => Promise<T>): Promise<T> {
    this.inTransaction = true
    try {
      return await callback(this as unknown as Database)
    } finally {
      this.inTransaction = false
    }
  }

  async exec(statement: SqlStatement | string) {
    if (typeof statement === 'string') return { rows: [] }
    this.statements.push(statement)
    if (statement.text.includes('select * from resource_cleanup_outbox')) {
      return { rows: this.cleanupRow ? [this.cleanupRow] : [] }
    }
    if (statement.text.includes('insert into resource_cleanup_outbox')) {
      let now = new Date('2026-07-13T00:00:00.000Z')
      this.cleanupRow = {
        id: statement.values[0], kind: statement.values[1], resource_id: statement.values[2],
        blob_key: statement.values[3], handover_id: statement.values[4], job_id: statement.values[5],
        revision: statement.values[6], status: 'queued', attempts: 0, next_retry_at: now,
        locked_by: null, locked_until: null, last_error: null, outcome: null,
        created_at: now, started_at: null, completed_at: null, updated_at: now,
      }
      return { rows: [this.cleanupRow] }
    }
    if (statement.text.includes('order by created_at desc limit 1')) {
      return { rows: this.conflict ? [{ id: 'cleanup-1', status: 'queued' }] : [] }
    }
    return { rows: [] }
  }
}

describe('generic resource cleanup outbox', () => {
  it('accepts a future provider artifact kind with an opaque resource id', async () => {
    let db = new GenericCleanupDatabase()
    let item = await enqueueCleanup(db as unknown as Database, {
      id: 'cleanup-provider-1',
      kind: 'assemblyai-transcript',
      resourceId: 'provider/resource:opaque',
      handoverId: 'handover-1',
      jobId: 'job-1',
      revision: 3,
    })

    assert.equal(item.kind, 'assemblyai-transcript')
    assert.equal(item.resourceId, 'provider/resource:opaque')
    assert.equal(item.blobKey, null)
    assert.equal(item.handoverId, 'handover-1')
    assert.equal(item.jobId, 'job-1')
    assert.equal(item.revision, 3)
    assert.equal(item.status, 'queued')
    assert.equal(db.inTransaction, false)
    assert.match(db.statements[0]!.text, /select \* from resource_cleanup_outbox[\s\S]*for update/)
    assert.match(db.statements[1]!.text, /pg_advisory_xact_lock\(hashtextextended/)
    assert.match(db.statements[2]!.text, /select \* from resource_cleanup_outbox[\s\S]*for update/)
    assert.match(db.statements[3]!.text, /insert into resource_cleanup_outbox/)
  })

  it('locks an existing cleanup row before the advisory lock and reuses it', async () => {
    let db = new GenericCleanupDatabase()
    let input = {
      id: 'cleanup-provider-1', kind: 'assemblyai-transcript', resourceId: 'provider/resource:opaque',
      handoverId: 'handover-1', jobId: 'job-1', revision: 3,
    }
    let first = await enqueueCleanup(db as unknown as Database, input)
    db.statements = []

    let retry = await enqueueCleanup(db as unknown as Database, { ...input, id: 'cleanup-provider-retry' })

    assert.equal(retry.id, first.id)
    assert.equal(db.statements.length, 2)
    assert.match(db.statements[0]!.text, /select \* from resource_cleanup_outbox[\s\S]*for update/)
    assert.match(db.statements[1]!.text, /pg_advisory_xact_lock/)
  })

  it('requires a local audio resource id to equal its persisted blob key', async () => {
    let db = new GenericCleanupDatabase()
    await assert.rejects(
      () => enqueueCleanup(db as unknown as Database, {
        kind: LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
        resourceId: 'one.webm',
        blobKey: 'two.webm',
        handoverId: 'handover-1',
        jobId: 'job-1',
        revision: 1,
      }),
      /resourceId and blobKey to match/,
    )
    assert.deepEqual(db.statements, [])
  })

  it('takes the advisory lock before checking assignment conflicts', async () => {
    let db = new GenericCleanupDatabase()
    await lockAudioBlobKeyForReferenceAssignment(db as unknown as Database, 'audio.webm')
    assert.match(db.statements[0]!.text, /pg_advisory_xact_lock/)
    assert.match(db.statements[1]!.text, /resource_cleanup_outbox/)
  })

  it('serializes scheduling against a phantom reference assignment in Postgres', async () => {
    if (!process.env.DATABASE_URL) return
    let scheduler = createDataRuntime(), writer = createDataRuntime()
    let table = await scheduler.db.exec(sql`select to_regclass('resource_cleanup_outbox') as table_name`)
    if (!table.rows?.[0]?.table_name) { await scheduler.close(); await writer.close(); return }
    let blobKey = `${randomUUID()}.webm`, cleanupId = randomUUID()
    let heldResolve!: () => void
    let continueResolve!: () => void
    let lockHeld = new Promise<void>((resolve) => { heldResolve = resolve })
    let mayContinue = new Promise<void>((resolve) => { continueResolve = resolve })
    let scheduling: Promise<void> | null = null
    try {
      scheduling = scheduler.db.transaction(async (tx) => {
        await enqueueResourceCleanupIfEligibleInTransaction(tx, {
          id: cleanupId,
          kind: LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
          resourceId: blobKey,
          blobKey,
          handoverId: 'handover-race-test',
          jobId: 'job-race-test',
          revision: 1,
        }, async () => {
          heldResolve()
          await mayContinue
          return true
        })
      })
      await lockHeld

      let writerSettled = false
      let assignment = writer.db.transaction(async (tx) => {
        await lockAudioBlobKeyForReferenceAssignment(tx, blobKey)
      }).then(
        () => { writerSettled = true; assert.fail('Expected cleanup intent to reject the assignment') },
        (error: unknown) => {
          writerSettled = true
          assert.ok(error instanceof ResourceCleanupConflictError)
        },
      )
      await new Promise((resolve) => setTimeout(resolve, 25))
      assert.equal(writerSettled, false)

      continueResolve()
      await scheduling
      await assignment
      assert.equal(writerSettled, true)
    } finally {
      continueResolve?.()
      await scheduling?.catch(() => undefined)
      await scheduler.db.exec(sql`delete from resource_cleanup_outbox where id=${cleanupId}`)
      await scheduler.close()
      await writer.close()
    }
  })

  it('never assigns an object after its provisional cleanup completed', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let blobKey = `${randomUUID()}.webm`
    let userId = randomUUID()
    let recordingUploadId = randomUUID()
    let cleanupId = ''
    try {
      let cleanup = await enqueueProvisionalAudioUploadCleanup(runtime.db, {
        blobKey,
        userId,
        recordingUploadId,
      })
      cleanupId = cleanup.id
      await runtime.db.exec(sql`
        update resource_cleanup_outbox set status = 'completed', completed_at = now(), outcome = 'deleted'
        where id = ${cleanup.id}
      `)
      await assert.rejects(
        () => runtime.db.transaction((tx) => consumeProvisionalAudioUploadCleanupInTransaction(tx, {
          cleanupId: cleanup.id,
          blobKey,
          userId,
          recordingUploadId,
        })),
        /already been cleaned up/,
      )
    } finally {
      if (cleanupId) await runtime.db.exec(sql`delete from resource_cleanup_outbox where id = ${cleanupId}`)
      await runtime.close()
    }
  })

  it('locks every audio reference-creation path before its first write', async () => {
    let [controller, repository, queue] = await Promise.all([
      fs.readFile(new URL('../../app/actions/actions/controller.tsx', import.meta.url), 'utf8'),
      fs.readFile(new URL('../../app/data/repository.ts', import.meta.url), 'utf8'),
      fs.readFile(new URL('../../app/data/queue.ts', import.meta.url), 'utf8'),
    ])
    let before = (source: string, lock: string, write: string) => {
      let lockIndex = source.indexOf(lock)
      let writeIndex = source.indexOf(write)
      assert.notEqual(lockIndex, -1, `Expected ${lock}`)
      assert.notEqual(writeIndex, -1, `Expected ${write}`)
      assert.ok(lockIndex < writeIndex, `${lock} must precede ${write}`)
    }

    let initialCreateStart = controller.indexOf('let result = await db.transaction')
    let initialCreate = controller.slice(
      initialCreateStart,
      controller.indexOf("return saved(context, 'Handover queued for processing.'", initialCreateStart),
    )
    before(initialCreate, 'consumeProvisionalAudioUploadCleanupInTransaction(tx', 'createHandover(tx')

    let extension = repository.slice(
      repository.indexOf('export async function extendHandover'),
      repository.indexOf('export async function attachHandoverAudio'),
    )
    before(extension, 'select * from handovers where id = ${input.id} for update', 'tx.create(handoverAudio')
    before(extension, 'consumeProvisionalAudioUploadCleanupInTransaction(tx', 'tx.create(handoverAudio')

    let attachment = repository.slice(
      repository.indexOf('export async function attachHandoverAudio'),
      repository.indexOf('export async function deleteHandoverAndCollectOrphanedAudioKeys'),
    )
    before(attachment, 'lockAudioBlobKeyForReferenceAssignment(tx, input.key)', 'tx.create(handoverAudio')

    let assignment = repository.slice(repository.indexOf('export async function createAssignment'))
    before(assignment, 'for (let key of copiedAudioKeys) await lockAudioBlobKeyForReferenceAssignment(tx, key)', 'insert into handovers')
    assert.match(assignment, /copiedAudioKeys = \[\.\.\.new Set\([\s\S]*\)\]\.sort\(\)/)

    let enqueue = queue.slice(
      queue.indexOf('async function enqueueLockedHandoverJob'),
      queue.indexOf('export async function claimNextHandoverJob'),
    )
    before(enqueue, 'lockAudioBlobKeyForReferenceAssignment(tx, audioBlobKey)', 'insert into handover_jobs')
  })
})
