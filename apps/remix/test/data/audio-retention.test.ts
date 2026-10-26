import { randomUUID } from 'node:crypto'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { sql, type Database, type SqlStatement } from 'remix/data-table'

import {
  createSuccessfulTranscriptionAudioRetention,
  isSuccessfulTranscriptionAudioDeletionConfirmed,
  retainUploadedAudioAfterTranscription,
  scheduleSuccessfulTranscriptionAudioCleanupInTransaction,
} from '../../app/data/audio-retention.ts'
import {
  lockAudioBlobKeyForReferenceAssignment,
  ResourceCleanupConflictError,
} from '../../app/data/resource-cleanup.ts'
import { deleteHandoverAndCollectOrphanedAudioKeys } from '../../app/data/repository.ts'
import { createDataRuntime } from '../../app/data/runtime.ts'

type Eligibility = {
  payload_audio_blob_key?: string | null
  metadata_persisted?: boolean
  metadata_mocked?: boolean | string | null
  run_confirmed?: boolean
}

type FakeCleanupRow = Record<string, unknown> & {
  id: string
  status: 'queued' | 'running' | 'deferred' | 'completed' | 'failed'
  attempts: number
  deletion_required: boolean
}

class RetentionDatabase {
  statements: SqlStatement[] = []
  transactionDepth = 0
  cleanup: FakeCleanupRow | null
  eligibility: Eligibility | null
  activeTranscription: boolean
  sharedAudio: boolean

  constructor(options: {
    eligibility?: Eligibility | null
    existingCleanup?: Partial<FakeCleanupRow> | null
    activeTranscription?: boolean
    sharedAudio?: boolean
  } = {}) {
    this.eligibility = options.eligibility === undefined ? {
      payload_audio_blob_key: 'processed.webm',
      metadata_persisted: true,
      metadata_mocked: false,
      run_confirmed: true,
    } : options.eligibility
    this.activeTranscription = options.activeTranscription ?? false
    this.sharedAudio = options.sharedAudio ?? false
    this.cleanup = options.existingCleanup === undefined || options.existingCleanup === null
      ? null
      : this.row(options.existingCleanup)
  }

  private row(patch: Partial<FakeCleanupRow> = {}): FakeCleanupRow {
    let now = new Date('2026-07-13T00:00:00.000Z')
    return {
      id: 'cleanup-1', kind: 'local-audio-object', resource_id: 'processed.webm', blob_key: 'processed.webm',
      handover_id: 'handover-1', job_id: 'job-1', revision: 2, status: 'queued', attempts: 0,
      deletion_required: false,
      next_retry_at: now, locked_by: null, locked_until: null, last_error: null, outcome: null,
      created_at: now, started_at: null, completed_at: null, updated_at: now,
      ...patch,
    }
  }

  async transaction<T>(callback: (db: Database) => Promise<T>): Promise<T> {
    this.transactionDepth += 1
    try {
      return await callback(this as unknown as Database)
    } finally {
      this.transactionDepth -= 1
    }
  }

  async exec(statement: SqlStatement | string) {
    if (typeof statement === 'string') return { rows: [] }
    this.statements.push(statement)
    let text = statement.text

    if (text.includes('pg_advisory_xact_lock')) return { rows: [{ pg_advisory_xact_lock: null }] }
    if (text.includes("j.payload ->> 'audioBlobKey' as payload_audio_blob_key")) {
      return { rows: this.eligibility ? [this.eligibility] : [] }
    }
    if (text.includes('insert into resource_cleanup_outbox')) {
      this.cleanup ??= this.row({
        id: String(statement.values[0]),
        deletion_required: statement.values.includes(true),
      })
      return { rows: [this.cleanup] }
    }
    if (text.includes('where kind =') && text.includes('job_id =') && text.includes('deletion_required = true')) {
      return { rows: this.cleanup?.deletion_required ? [this.cleanup] : [] }
    }
    if (text.includes('for update skip locked')) {
      if (!this.cleanup || !['queued', 'deferred', 'failed'].includes(this.cleanup.status)) return { rows: [] }
      return { rows: [this.cleanup] }
    }
    if (text.includes("status = 'running', attempts = attempts + 1")) {
      if (!this.cleanup) return { rows: [] }
      this.cleanup = this.row({
        ...this.cleanup,
        status: 'running',
        attempts: this.cleanup.attempts + 1,
        locked_by: 'cleanup-worker',
        locked_until: new Date('2026-07-13T00:01:00.000Z'),
      })
      return { rows: [this.cleanup] }
    }
    if (text.includes('as active_transcription')) {
      return { rows: [{ active_transcription: this.activeTranscription, shared_audio: this.sharedAudio }] }
    }
    if (text.includes("status = 'completed', locked_by = null")) {
      if (!this.cleanup) return { rows: [] }
      this.cleanup = this.row({
        ...this.cleanup,
        status: 'completed',
        locked_by: null,
        locked_until: null,
        outcome: String(statement.values[0]),
        completed_at: new Date('2026-07-13T00:00:02.000Z'),
      })
      return { rows: [{ id: this.cleanup.id }] }
    }
    if (text.includes('next_retry_at = now() +') && text.includes('last_error =')) {
      if (!this.cleanup) return { rows: [] }
      let status = String(statement.values[0]) as 'deferred' | 'failed'
      this.cleanup = this.row({
        ...this.cleanup,
        status,
        locked_by: null,
        locked_until: null,
        last_error: String(statement.values[2]),
      })
      return { rows: [{ id: this.cleanup.id }] }
    }
    if (text.includes("status = 'running' and locked_by =") && text.includes('for update')) {
      return { rows: this.cleanup?.status === 'running' ? [this.cleanup] : [] }
    }
    if (text.includes('where kind =') && text.includes('resource_id =') && text.includes('handover_id =')) {
      return { rows: this.cleanup ? [this.cleanup] : [] }
    }
    if (text.includes('where kind =') && text.includes('blob_key =') && text.includes('order by created_at')) {
      return { rows: this.cleanup ? [this.cleanup] : [] }
    }
    if (text.includes('select * from resource_cleanup_outbox where id =')) {
      return { rows: this.cleanup ? [this.cleanup] : [] }
    }
    return { rows: [] }
  }
}

function deletingStorage(db: RetentionDatabase, options: { deleted?: boolean; fail?: boolean } = {}) {
  let keys: string[] = []
  let transactionDepths: number[] = []
  return {
    keys,
    transactionDepths,
    storage: {
      async delete(key: string) {
        keys.push(key)
        transactionDepths.push(db.transactionDepth)
        if (options.fail) throw new Error('provider-controlled storage detail')
        return options.deleted ?? true
      },
    },
  }
}

function releaseWith(
  db: RetentionDatabase,
  storage: { delete(key: string): Promise<boolean> },
  env: Record<string, string | undefined> = { NODE_ENV: 'production' },
  input: { deletionRequired?: boolean } = {},
) {
  let retention = createSuccessfulTranscriptionAudioRetention({
    db: db as unknown as Database,
    storage,
    env,
    workerId: 'cleanup-worker',
    retryBaseMs: 1,
  })
  return () => retention.release({
    handoverId: 'handover-1',
    jobId: 'job-1',
    revision: 2,
    processedAudioBlobKey: 'processed.webm',
    ...input,
  })
}

describe('durable successful-transcription audio cleanup', () => {
  it('defaults to retention outside production and cleanup in production', () => {
    assert.equal(retainUploadedAudioAfterTranscription({ NODE_ENV: 'development' }), true)
    assert.equal(retainUploadedAudioAfterTranscription({ NODE_ENV: 'test' }), true)
    assert.equal(retainUploadedAudioAfterTranscription({ NODE_ENV: 'production' }), false)
    assert.equal(retainUploadedAudioAfterTranscription({ NODE_ENV: 'production', RETAIN_UPLOADED_AUDIO_AFTER_TRANSCRIPTION: ' true ' }), true)
    assert.equal(retainUploadedAudioAfterTranscription({ NODE_ENV: 'development', RETAIN_UPLOADED_AUDIO_AFTER_TRANSCRIPTION: 'false' }), false)
  })

  it('does not touch storage or the database when policy retains audio', async () => {
    let db = new RetentionDatabase()
    let store = deletingStorage(db)
    let result = await releaseWith(db, store.storage, {
      NODE_ENV: 'production', RETAIN_UPLOADED_AUDIO_AFTER_TRANSCRIPTION: 'true',
    })()
    assert.deepEqual(result, { status: 'retained-by-policy' })
    assert.equal(isSuccessfulTranscriptionAudioDeletionConfirmed(result), false)
    assert.deepEqual(store.keys, [])
    assert.deepEqual(db.statements, [])
  })

  it('forces deletion for one job despite the environment retention policy', async () => {
    let db = new RetentionDatabase()
    let store = deletingStorage(db)
    let result = await releaseWith(db, store.storage, {
      NODE_ENV: 'development', RETAIN_UPLOADED_AUDIO_AFTER_TRANSCRIPTION: 'true',
    }, { deletionRequired: true })()

    assert.equal(result.status, 'deleted')
    assert.equal(isSuccessfulTranscriptionAudioDeletionConfirmed(result), true)
    assert.deepEqual(store.keys, ['processed.webm'])
    assert.equal(db.cleanup?.status, 'completed')
  })

  it('keeps required deletion deferred while another audio reference is active', async () => {
    let db = new RetentionDatabase({ sharedAudio: true })
    let store = deletingStorage(db)
    let result = await releaseWith(db, store.storage, {
      NODE_ENV: 'development', RETAIN_UPLOADED_AUDIO_AFTER_TRANSCRIPTION: 'true',
    }, { deletionRequired: true })()

    assert.equal(result.status, 'deferred')
    assert.equal(isSuccessfulTranscriptionAudioDeletionConfirmed(result), false)
    if (result.status === 'deferred') assert.equal(result.reason, 'shared-audio-reference')
    assert.deepEqual(store.keys, [])
    assert.equal(db.cleanup?.status, 'deferred')
  })

  it('schedules cleanup intent inside the caller transaction without touching storage', async () => {
    let db = new RetentionDatabase()
    let result = await db.transaction((tx) => scheduleSuccessfulTranscriptionAudioCleanupInTransaction(tx, {
      handoverId: 'handover-1',
      jobId: 'job-1',
      revision: 2,
      processedAudioBlobKey: 'processed.webm',
      transcriptionMocked: false,
    }, { NODE_ENV: 'production' }))

    assert.equal(result.status, 'scheduled')
    assert.ok(db.statements.some((statement) => statement.text.includes('insert into resource_cleanup_outbox')))
  })

  it('schedules required cleanup inside the transaction despite retain policy', async () => {
    let db = new RetentionDatabase()
    let result = await db.transaction((tx) => scheduleSuccessfulTranscriptionAudioCleanupInTransaction(tx, {
      handoverId: 'handover-1',
      jobId: 'job-1',
      revision: 2,
      processedAudioBlobKey: 'processed.webm',
      transcriptionMocked: false,
      deletionRequired: true,
    }, { NODE_ENV: 'development', RETAIN_UPLOADED_AUDIO_AFTER_TRANSCRIPTION: 'true' }))

    assert.equal(result.status, 'scheduled')
    assert.equal(db.cleanup?.deletion_required, true)
    assert.ok(db.statements.some((statement) => statement.text.includes('insert into resource_cleanup_outbox')))
  })

  it('drains required cleanup retries even when ordinary audio retention is enabled', async () => {
    let db = new RetentionDatabase({
      eligibility: null,
      existingCleanup: {
        status: 'failed',
        attempts: 1,
        last_error: 'Local audio object deletion failed.',
        deletion_required: true,
      },
    })
    let store = deletingStorage(db)
    let retention = createSuccessfulTranscriptionAudioRetention({
      db: db as unknown as Database,
      storage: store.storage,
      env: { NODE_ENV: 'development', RETAIN_UPLOADED_AUDIO_AFTER_TRANSCRIPTION: 'true' },
      workerId: 'cleanup-worker',
      retryBaseMs: 1,
    })

    let result = await retention.processNext()
    assert.equal(result.status, 'deleted')
    assert.deepEqual(store.keys, ['processed.webm'])
    assert.ok(db.statements.some((statement) => statement.text.includes('deletion_required =')))
  })

  it('confirms an original required cleanup without a copied raw-audio reference', async () => {
    let db = new RetentionDatabase({
      eligibility: null,
      existingCleanup: { status: 'completed', outcome: 'deleted', deletion_required: true },
    })
    let store = deletingStorage(db)
    let retention = createSuccessfulTranscriptionAudioRetention({
      db: db as unknown as Database,
      storage: store.storage,
      env: { NODE_ENV: 'development', RETAIN_UPLOADED_AUDIO_AFTER_TRANSCRIPTION: 'true' },
      workerId: 'cleanup-worker',
    })

    let result = await retention.confirmRequiredDeletion({ jobId: 'job-1', revision: 2 })
    assert.equal(result.status, 'deleted')
    assert.deepEqual(store.keys, [])
  })

  it('rolls cleanup intent back with its surrounding transcription transaction', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime(), blobKey = `${randomUUID()}.webm`
    try {
      await assert.rejects(() => runtime.db.transaction(async (tx) => {
        await scheduleSuccessfulTranscriptionAudioCleanupInTransaction(tx, {
          handoverId: randomUUID(),
          jobId: randomUUID(),
          revision: 1,
          processedAudioBlobKey: blobKey,
          transcriptionMocked: false,
        }, { NODE_ENV: 'production' })
        throw new Error('rollback transcription completion')
      }), /rollback transcription completion/)
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int as count from resource_cleanup_outbox where blob_key=${blobKey}
      `)).rows?.[0]?.count, 0)
    } finally {
      await runtime.db.exec(sql`delete from resource_cleanup_outbox where blob_key=${blobKey}`)
      await runtime.close()
    }
  })

  it('enqueues, claims with SKIP LOCKED, deletes outside the transaction, and clears exact references', async () => {
    let db = new RetentionDatabase()
    let store = deletingStorage(db)
    let result = await releaseWith(db, store.storage)()

    assert.equal(result.status, 'deleted')
    assert.deepEqual(store.keys, ['processed.webm'])
    assert.deepEqual(store.transactionDepths, [0])
    assert.equal(db.cleanup?.status, 'completed')
    assert.equal(db.cleanup?.attempts, 1)
    let statements = db.statements.map((statement) => statement.text).join('\n')
    assert.match(statements, /insert into resource_cleanup_outbox/)
    assert.match(statements, /for update skip locked/)
    assert.match(statements, /pg_advisory_xact_lock\(hashtextextended/)
    assert.match(statements, /where id = .*and audio_blob_key =/s)
    assert.match(statements, /where handover_id = .*and revision = .*and blob_key =/s)
    assert.match(statements, /where id = .*and handover_id = .*and revision =/s)
    assert.doesNotMatch(statements, /delete from handover_audio where blob_key =/)
    let handoverLock = db.statements.findIndex((statement) => /select id from handovers where id = .*for update/s.test(statement.text))
    let jobLock = db.statements.findIndex((statement) => /select id from handover_jobs.*for update/s.test(statement.text))
    let finalOutboxLock = db.statements.findIndex((statement, index) => (
      index > jobLock
      && /select \* from resource_cleanup_outbox.*status = 'running'.*locked_by = .*for update/s.test(statement.text)
    ))
    let finalResourceLock = db.statements.findIndex((statement, index) => (
      index > finalOutboxLock && statement.text.includes('pg_advisory_xact_lock')
    ))
    assert.ok(handoverLock >= 0 && handoverLock < jobLock)
    assert.ok(jobLock < finalOutboxLock)
    assert.ok(finalOutboxLock < finalResourceLock)
  })

  it('completes idempotently when the object is already missing', async () => {
    let db = new RetentionDatabase()
    let store = deletingStorage(db, { deleted: false })
    let result = await releaseWith(db, store.storage)()
    assert.equal(result.status, 'already-missing')
    assert.equal(isSuccessfulTranscriptionAudioDeletionConfirmed(result), true)
    assert.equal(db.cleanup?.status, 'completed')
    assert.equal(db.cleanup?.outcome, 'already-missing')
  })

  it('keeps a failed delete retryable and does not persist provider-controlled errors', async () => {
    let db = new RetentionDatabase()
    let store = deletingStorage(db, { fail: true })
    let result = await releaseWith(db, store.storage)()
    assert.equal(result.status, 'delete-failed')
    assert.equal(isSuccessfulTranscriptionAudioDeletionConfirmed(result), false)
    assert.equal(db.cleanup?.status, 'failed')
    assert.equal(db.cleanup?.last_error, 'Local audio object deletion failed.')
    assert.doesNotMatch(String(db.cleanup?.last_error), /provider-controlled/)
    assert.ok(!db.statements.some((statement) => statement.text.includes('delete from handover_audio')))
  })

  it('reclaims a retryable failed outbox row without repeating eligibility work', async () => {
    let db = new RetentionDatabase({
      eligibility: null,
      existingCleanup: { status: 'failed', attempts: 1, last_error: 'Local audio object deletion failed.' },
    })
    let store = deletingStorage(db)
    let retention = createSuccessfulTranscriptionAudioRetention({
      db: db as unknown as Database,
      storage: store.storage,
      env: { NODE_ENV: 'production' },
      workerId: 'cleanup-worker',
      retryBaseMs: 1,
    })

    let result = await retention.processNext()
    assert.equal(result.status, 'deleted')
    assert.equal(db.cleanup?.status, 'completed')
    assert.equal(db.cleanup?.attempts, 2)
    assert.deepEqual(store.keys, ['processed.webm'])
    assert.ok(!db.statements.some((statement) => statement.text.includes("j.payload ->> 'audioBlobKey'")))
  })

  it('records a deferred retry instead of deleting while the blob is still referenced', async () => {
    for (let option of [
      { activeTranscription: true, expected: 'active-transcription-reference' },
      { sharedAudio: true, expected: 'shared-audio-reference' },
    ]) {
      let db = new RetentionDatabase(option)
      let store = deletingStorage(db)
      let result = await releaseWith(db, store.storage)()
      assert.equal(result.status, 'deferred')
      if (result.status === 'deferred') assert.equal(result.reason, option.expected)
      assert.equal(db.cleanup?.status, 'deferred')
      assert.deepEqual(store.keys, [])
    }
  })

  it('does not enqueue when ownership or durable real-transcription evidence is missing', async () => {
    for (let testCase of [
      { eligibility: null, reason: 'job-mismatch' },
      { eligibility: { payload_audio_blob_key: 'other.webm', metadata_persisted: true, metadata_mocked: false, run_confirmed: true }, reason: 'job-mismatch' },
      { eligibility: { payload_audio_blob_key: 'processed.webm', metadata_persisted: false, metadata_mocked: false, run_confirmed: true }, reason: 'transcript-not-persisted' },
      { eligibility: { payload_audio_blob_key: 'processed.webm', metadata_persisted: true, metadata_mocked: false, run_confirmed: false }, reason: 'transcript-not-persisted' },
      { eligibility: { payload_audio_blob_key: 'processed.webm', metadata_persisted: true, metadata_mocked: true, run_confirmed: true }, reason: 'mock-transcription' },
    ] satisfies Array<{ eligibility: Eligibility | null; reason: string }>) {
      let db = new RetentionDatabase({ eligibility: testCase.eligibility })
      let store = deletingStorage(db)
      let result = await releaseWith(db, store.storage)()
      assert.equal(result.status, 'not-eligible')
      if (result.status === 'not-eligible') assert.equal(result.reason, testCase.reason)
      assert.equal(db.cleanup, null)
      assert.deepEqual(store.keys, [])
    }
  })

  it('reuses a completed exact outbox row without re-deleting or requiring cleared job payload data', async () => {
    let db = new RetentionDatabase({
      eligibility: null,
      existingCleanup: { status: 'completed', outcome: 'deleted', attempts: 1 },
    })
    let store = deletingStorage(db)
    let result = await releaseWith(db, store.storage)()
    assert.equal(result.status, 'deleted')
    assert.deepEqual(store.keys, [])
    assert.ok(!db.statements.some((statement) => statement.text.includes("j.payload ->> 'audioBlobKey'")))
  })

  it('rejects invalid input before opening a transaction', async () => {
    let db = new RetentionDatabase()
    let store = deletingStorage(db)
    let retention = createSuccessfulTranscriptionAudioRetention({
      db: db as unknown as Database,
      storage: store.storage,
      env: { NODE_ENV: 'production' },
    })
    await assert.rejects(() => retention.release({
      handoverId: 'handover-1', jobId: 'job-1', revision: 0, processedAudioBlobKey: 'processed.webm',
    }), /positive integer/)
    assert.deepEqual(db.statements, [])
  })

  it('prevents reference assignment once cleanup intent exists', async () => {
    let db = new RetentionDatabase({ existingCleanup: { status: 'running' } })
    await assert.rejects(
      () => lockAudioBlobKeyForReferenceAssignment(db as unknown as Database, 'processed.webm'),
      ResourceCleanupConflictError,
    )
    assert.ok(db.statements.some((statement) => statement.text.includes('pg_advisory_xact_lock')))
  })

  it('persists audit state and clears only the exact revision in Postgres', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let table = await runtime.db.exec(sql`select to_regclass('resource_cleanup_outbox') as table_name`)
    if (!table.rows?.[0]?.table_name) { await runtime.close(); return }
    let userId = randomUUID(), handoverId = randomUUID(), jobId = randomUUID()
    let processedKey = `${randomUUID()}.webm`, historicalKey = `${randomUUID()}.webm`
    try {
      await runtime.db.exec(sql`insert into users(id,full_name,occupation,department) values(${userId},'Cleanup Test','Nurse','Ward')`)
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,title,source_department,context_type,consent_mode,priority_preference,
          audio_blob_key,audio_content_type,audio_original_filename,audio_size_bytes,transcript,
          transcription_metadata,processing_status,version,current_job_id,created_at,updated_at
        ) values(
          ${handoverId},${userId},'Cleanup test','Ward','shift-handover','verbal','balanced',
          ${processedKey},'audio/webm','extension.webm',42,'Stored transcript',
          ${JSON.stringify({ engine: 'assemblyai', mocked: false })}::jsonb,'analysing',2,${jobId},now(),now()
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(id,handover_id,revision,kind,status,attempts,payload,created_at,updated_at)
        values(${jobId},${handoverId},2,'extend','running',1,
          ${JSON.stringify({ audioBlobKey: processedKey, retryFrom: 'analysis' })}::jsonb,now(),now())
      `)
      await runtime.db.exec(sql`
        insert into handover_audio(id,handover_id,revision,purpose,blob_key,content_type,original_filename,size_bytes,created_at)
        values
          (${randomUUID()},${handoverId},1,'initial',${historicalKey},'audio/webm','initial.webm',21,now()),
          (${randomUUID()},${handoverId},2,'extension',${processedKey},'audio/webm','extension.webm',42,now())
      `)
      await runtime.db.exec(sql`
        insert into transcription_runs(id,handover_id,job_id,revision,provider,status,metadata,started_at,completed_at)
        values(${randomUUID()},${handoverId},${jobId},2,'assemblyai','completed','{}'::jsonb,now(),now())
      `)

      let deleted: string[] = []
      let retention = createSuccessfulTranscriptionAudioRetention({
        db: runtime.db,
        storage: { async delete(key) { deleted.push(key); return true } },
        env: { NODE_ENV: 'production' },
        workerId: `cleanup-${randomUUID()}`,
      })
      let result = await retention.release({
        handoverId, jobId, revision: 2, processedAudioBlobKey: processedKey,
      })
      assert.equal(result.status, 'deleted')
      assert.deepEqual(deleted, [processedKey])
      assert.deepEqual((await runtime.db.exec(sql`
        select blob_key from handover_audio where handover_id=${handoverId} order by revision
      `)).rows, [{ blob_key: historicalKey }])
      let audit = (await runtime.db.exec(sql`
        select kind,resource_id,blob_key,handover_id,job_id,revision,status,attempts,outcome
        from resource_cleanup_outbox where handover_id=${handoverId}
      `)).rows?.[0]
      assert.deepEqual(audit, {
        kind: 'local-audio-object', resource_id: processedKey, blob_key: processedKey,
        handover_id: handoverId, job_id: jobId, revision: 2, status: 'completed', attempts: 1, outcome: 'deleted',
      })
    } finally {
      await runtime.db.exec(sql`delete from resource_cleanup_outbox where handover_id=${handoverId}`)
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.db.exec(sql`delete from users where id=${userId}`)
      await runtime.close()
    }
  })

  for (let reference of [
    { name: 'superseded failed attempts', status: 'failed', current: false, separateHandover: false, expected: 'deleted' },
    { name: 'another handover\'s current failed attempt', status: 'failed', current: true, separateHandover: true, expected: 'deferred' },
    { name: 'a queued attempt that is not the queue head', status: 'queued', current: false, separateHandover: false, expected: 'deferred' },
    { name: 'a running attempt that is not the current job', status: 'running', current: false, separateHandover: false, expected: 'deferred' },
  ] as const) {
    it(`handles required cleanup with ${reference.name} in Postgres`, async () => {
      if (!process.env.DATABASE_URL) return
      let runtime = createDataRuntime()
      let table = await runtime.db.exec(sql`select to_regclass('resource_cleanup_outbox') as table_name`)
      if (!table.rows?.[0]?.table_name) { await runtime.close(); return }
      let userId = randomUUID(), handoverId = randomUUID(), jobId = randomUUID()
      let foreignHandoverId = reference.separateHandover ? randomUUID() : handoverId
      let foreignJobId = randomUUID(), earlierFailureId = randomUUID(), blobKey = `${randomUUID()}.webm`
      try {
        await runtime.db.exec(sql`
          insert into users(id,full_name,occupation,department)
          values(${userId},'Retry Cleanup Test','Nurse','Ward')
        `)
        await runtime.db.exec(sql`
          insert into handovers(
            id,created_by_user_id,title,source_department,context_type,consent_mode,priority_preference,
            audio_blob_key,transcript,transcription_metadata,processing_status,version,current_job_id
          ) values(
            ${handoverId},${userId},'Retry cleanup','Ward','shift-handover','verbal','balanced',
            ${blobKey},'Synthetic persisted transcript',${JSON.stringify({ engine: 'omi', mocked: false })}::jsonb,
            'analysing',1,${jobId}
          )
        `)
        if (reference.separateHandover) {
          // No handover-level audio reference: this case specifically proves
          // that a different handover's retryable failed job protects the file.
          await runtime.db.exec(sql`
            insert into handovers(
              id,created_by_user_id,title,source_department,context_type,consent_mode,priority_preference,
              processing_status,version,current_job_id
            ) values(
              ${foreignHandoverId},${userId},'Current failed reference','Ward','shift-handover','verbal','balanced',
              'failed',1,${foreignJobId}
            )
          `)
        }
        await runtime.db.exec(sql`
          insert into handover_jobs(id,handover_id,revision,kind,status,attempts,payload)
          values(
            ${jobId},${handoverId},1,'create','running',1,
            ${JSON.stringify({ audioBlobKey: blobKey, retryFrom: 'analysis' })}::jsonb
          ),(
            ${foreignJobId},${foreignHandoverId},1,'create',${reference.status},1,
            ${JSON.stringify({ audioBlobKey: blobKey })}::jsonb
          )
        `)
        if (reference.status === 'failed' && !reference.current) {
          // Two historical transcription failures reproduce repeated retries:
          // each new retry owns current_job_id while old failed rows remain.
          await runtime.db.exec(sql`
            insert into handover_jobs(id,handover_id,revision,kind,status,attempts,payload)
            values(${earlierFailureId},${handoverId},1,'create','failed',1,
              ${JSON.stringify({ audioBlobKey: blobKey })}::jsonb)
          `)
        }
        await runtime.db.exec(sql`
          insert into transcription_runs(id,handover_id,job_id,revision,provider,status,metadata,started_at,completed_at)
          values(${randomUUID()},${handoverId},${jobId},1,'omi','completed','{}'::jsonb,now(),now())
        `)

        let deleted: string[] = []
        let retention = createSuccessfulTranscriptionAudioRetention({
          db: runtime.db,
          storage: { async delete(key) { deleted.push(key); return true } },
          env: { NODE_ENV: 'development', RETAIN_UPLOADED_AUDIO_AFTER_TRANSCRIPTION: 'true' },
          workerId: `retry-cleanup-${randomUUID()}`,
        })
        let result = await retention.release({
          handoverId, jobId, revision: 1, processedAudioBlobKey: blobKey, deletionRequired: true,
        })
        assert.equal(result.status, reference.expected)
        if (reference.expected === 'deleted') {
          assert.deepEqual(deleted, [blobKey])
          assert.equal((await runtime.db.exec(sql`
            select audio_blob_key from handovers where id=${handoverId}
          `)).rows?.[0]?.audio_blob_key, null)
          assert.equal((await runtime.db.exec(sql`
            select count(*)::int as count from handover_jobs
            where handover_id=${handoverId} and status='failed' and payload->>'audioBlobKey'=${blobKey}
          `)).rows?.[0]?.count, 2)
        } else {
          assert.deepEqual(deleted, [])
          assert.equal(result.status === 'deferred' ? result.reason : null, 'active-transcription-reference')
          assert.equal((await runtime.db.exec(sql`
            select audio_blob_key from handovers where id=${handoverId}
          `)).rows?.[0]?.audio_blob_key, blobKey)
        }
        assert.deepEqual((await runtime.db.exec(sql`
          select status, deletion_required, outcome from resource_cleanup_outbox where job_id=${jobId}
        `)).rows, [{
          status: reference.expected === 'deleted' ? 'completed' : 'deferred',
          deletion_required: true,
          outcome: reference.expected === 'deleted' ? 'deleted' : null,
        }])
      } finally {
        await runtime.db.exec(sql`delete from resource_cleanup_outbox where handover_id=${handoverId}`)
        await runtime.db.exec(sql`delete from handovers where id in (${handoverId},${foreignHandoverId})`)
        await runtime.db.exec(sql`delete from users where id=${userId}`)
        await runtime.close()
      }
    })
  }

  it('converges shared assignment audio once every transcription has durable cleanup intent', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let table = await runtime.db.exec(sql`select to_regclass('resource_cleanup_outbox') as table_name`)
    if (!table.rows?.[0]?.table_name) { await runtime.close(); return }
    let userId = randomUUID(), blobKey = `${randomUUID()}.webm`
    let source = { handoverId: randomUUID(), jobId: randomUUID() }
    let recipient = { handoverId: randomUUID(), jobId: randomUUID() }
    try {
      await runtime.db.exec(sql`insert into users(id,full_name,occupation,department) values(${userId},'Shared Cleanup Test','Nurse','Ward')`)
      for (let item of [source, recipient]) {
        await runtime.db.exec(sql`
          insert into handovers(
            id,created_by_user_id,title,source_department,context_type,consent_mode,priority_preference,
            audio_blob_key,audio_content_type,audio_original_filename,audio_size_bytes,transcript,
            transcription_metadata,processing_status,version,current_job_id,created_at,updated_at
          ) values(
            ${item.handoverId},${userId},'Shared cleanup test','Ward','shift-handover','verbal','balanced',
            ${blobKey},'audio/webm','shared.webm',42,'Stored transcript',
            ${JSON.stringify({ engine: 'assemblyai', mocked: false })}::jsonb,'analysing',1,${item.jobId},now(),now()
          )
        `)
        await runtime.db.exec(sql`
          insert into handover_jobs(id,handover_id,revision,kind,status,attempts,payload,created_at,updated_at)
          values(${item.jobId},${item.handoverId},1,'create','running',1,
            ${JSON.stringify({ audioBlobKey: blobKey, retryFrom: 'analysis' })}::jsonb,now(),now())
        `)
        await runtime.db.exec(sql`
          insert into handover_audio(id,handover_id,revision,purpose,blob_key,content_type,original_filename,size_bytes,created_at)
          values(${randomUUID()},${item.handoverId},1,'initial',${blobKey},'audio/webm','shared.webm',42,now())
        `)
        await runtime.db.exec(sql`
          insert into transcription_runs(id,handover_id,job_id,revision,provider,status,metadata,started_at,completed_at)
          values(${randomUUID()},${item.handoverId},${item.jobId},1,'assemblyai','completed','{}'::jsonb,now(),now())
        `)
      }

      let objectExists = true, deletionAttempts = 0
      let retention = createSuccessfulTranscriptionAudioRetention({
        db: runtime.db,
        storage: { async delete(key) {
          assert.equal(key, blobKey)
          deletionAttempts += 1
          let deleted = objectExists
          objectExists = false
          return deleted
        } },
        env: { NODE_ENV: 'production' },
        workerId: `shared-cleanup-${randomUUID()}`,
        retryBaseMs: 1,
      })

      let first = await retention.release({
        handoverId: source.handoverId, jobId: source.jobId, revision: 1, processedAudioBlobKey: blobKey,
      })
      assert.equal(first.status, 'deferred')
      let second = await retention.release({
        handoverId: recipient.handoverId, jobId: recipient.jobId, revision: 1, processedAudioBlobKey: blobKey,
      })
      assert.equal(second.status, 'deleted')
      await runtime.db.exec(sql`
        update resource_cleanup_outbox set next_retry_at=now()
        where kind='local-audio-object' and blob_key=${blobKey} and status='deferred'
      `)
      // Retry this test's exact durable intent; the rehearsal database may
      // legitimately contain unrelated cleanup work from the running dev app.
      let final = await retention.release({
        handoverId: source.handoverId,
        jobId: source.jobId,
        revision: 1,
        processedAudioBlobKey: blobKey,
      })
      assert.equal(final.status, 'already-missing')
      assert.equal(deletionAttempts, 2)
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int as count from handover_audio where blob_key=${blobKey}
      `)).rows?.[0]?.count, 0)
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int as count from resource_cleanup_outbox
        where blob_key=${blobKey} and status='completed'
      `)).rows?.[0]?.count, 2)
    } finally {
      await runtime.db.exec(sql`delete from resource_cleanup_outbox where blob_key=${blobKey}`)
      await runtime.db.exec(sql`delete from handovers where id in (${source.handoverId},${recipient.handoverId})`)
      await runtime.db.exec(sql`delete from users where id=${userId}`)
      await runtime.close()
    }
  })

  it('drains explicit-deletion cleanup even when transcription policy retains audio', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let table = await runtime.db.exec(sql`select to_regclass('resource_cleanup_outbox') as table_name`)
    if (!table.rows?.[0]?.table_name) { await runtime.close(); return }
    let userId = randomUUID(), handoverId = randomUUID(), blobKey = `${randomUUID()}.webm`
    try {
      await runtime.db.exec(sql`insert into users(id,full_name,occupation,department) values(${userId},'Deletion Cleanup Test','Nurse','Ward')`)
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,title,source_department,context_type,consent_mode,
          priority_preference,processing_status,version,audio_blob_key,audio_content_type,
          audio_original_filename,audio_size_bytes,created_at,updated_at
        ) values(
          ${handoverId},${userId},'Deletion cleanup','Ward','shift-handover','verbal',
          'balanced','completed',1,${blobKey},'audio/webm','recording.webm',42,now(),now()
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_audio(id,handover_id,revision,purpose,blob_key,content_type,original_filename,size_bytes,created_at)
        values(${randomUUID()},${handoverId},1,'initial',${blobKey},'audio/webm','recording.webm',42,now())
      `)

      assert.deepEqual(
        await deleteHandoverAndCollectOrphanedAudioKeys(runtime.db, { id: handoverId, userId }),
        [blobKey],
      )
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int as count from handovers where id=${handoverId}
      `)).rows?.[0]?.count, 0)
      assert.deepEqual((await runtime.db.exec(sql`
        select kind,blob_key,handover_id,status from resource_cleanup_outbox where handover_id=${handoverId}
      `)).rows, [{ kind: 'local-audio-object', blob_key: blobKey, handover_id: handoverId, status: 'queued' }])

      let deleted: string[] = []
      let storageUnavailable = true
      let retention = createSuccessfulTranscriptionAudioRetention({
        db: runtime.db,
        storage: { async delete(key) {
          deleted.push(key)
          if (storageUnavailable) throw new Error('Temporary storage outage')
          return true
        } },
        env: { NODE_ENV: 'development', RETAIN_UPLOADED_AUDIO_AFTER_TRANSCRIPTION: 'true' },
        workerId: `deletion-cleanup-${randomUUID()}`,
        retryBaseMs: 1,
      })
      let first = await retention.processNext()
      assert.equal(first.status, 'delete-failed')
      assert.deepEqual(deleted, [blobKey])
      assert.equal((await runtime.db.exec(sql`
        select status from resource_cleanup_outbox where handover_id=${handoverId}
      `)).rows?.[0]?.status, 'failed')

      storageUnavailable = false
      await runtime.db.exec(sql`
        update resource_cleanup_outbox set next_retry_at=now() where handover_id=${handoverId}
      `)
      let result = await retention.processNext()
      assert.equal(result.status, 'deleted')
      assert.deepEqual(deleted, [blobKey, blobKey])
      assert.equal((await runtime.db.exec(sql`
        select status from resource_cleanup_outbox where handover_id=${handoverId}
      `)).rows?.[0]?.status, 'completed')
    } finally {
      await runtime.db.exec(sql`delete from resource_cleanup_outbox where handover_id=${handoverId}`)
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.db.exec(sql`delete from users where id=${userId}`)
      await runtime.close()
    }
  })
})
