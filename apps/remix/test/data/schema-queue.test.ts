import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { getTableName, sql, type Database, type SqlStatement } from 'remix/data-table'
import {
  createHandoverTask,
  createDataRuntime,
  createShift,
  discardFailedHandoverAttempt,
  extendHandover,
  getShiftForUser,
  updateTaskFields,
} from '../../app/data/index.ts'
import { acquireHandoverJobLease, claimNextHandoverJob, completeHandoverJob, enqueueHandoverJob, failHandoverJob, ratchetHandoverPrivacyFamily, retryFailedHandoverJob } from '../../app/data/queue.ts'
import * as schema from '../../app/data/schema.ts'
import type { HandoverTaskRow } from '../../app/data/schema.ts'

class RecordingDatabase {
  statements: SqlStatement[] = []
  async transaction<T>(callback: (db: Database) => Promise<T>): Promise<T> { return callback(this as unknown as Database) }
  async exec(statement: SqlStatement | string) {
    if (typeof statement !== 'string') this.statements.push(statement)
    if (typeof statement !== 'string' && /select coalesce\(source_handover_id, id\) as family_root_id/i.test(statement.text)) {
      return { rows: [{ family_root_id: 'handover-1' }] }
    }
    if (typeof statement !== 'string' && /select id, privacy_mode_floor, coalesce\(source_handover_id, id\) as family_root_id/i.test(statement.text)) {
      return { rows: [{ id: 'handover-1', privacy_mode_floor: 'cloud', family_root_id: 'handover-1' }] }
    }
    if (typeof statement !== 'string' && statement.text.includes('insert into handover_jobs')) {
      return { rows: [{
        id: 'job-1', handover_id: 'handover-1', revision: 1, kind: 'create', status: 'queued', attempts: 0,
        locked_by: null, locked_until: null, payload: {}, created_at: new Date(), started_at: null,
        completed_at: null, failed_at: null, updated_at: new Date(), error_message: null,
      }] }
    }
    return { rows: [] }
  }
}

class TaskUpdateDatabase {
  patch: Partial<HandoverTaskRow> | null = null
  task: HandoverTaskRow

  constructor() {
    let createdAt = new Date('2026-07-13T01:00:00.000Z')
    this.task = {
      id: 'task-1', handover_id: 'handover-1', patient_key: 'patient-1', title: 'Original action',
      due_label: 'Original due date', due_at: null, priority: 'urgent', status: 'open',
      reminder_enabled: true, carried_forward: false, source: 'uncertainty', related_uncertainty_id: 'uncertainty-1',
      created_at: createdAt, updated_at: createdAt,
    }
  }

  async find() { return this.task }
  async transaction<T>(callback: (db: Database) => Promise<T>): Promise<T> {
    return callback(this as unknown as Database)
  }
  async exec(statement: SqlStatement | string) {
    let text = typeof statement === 'string' ? statement : statement.text
    if (/select handover_id from handover_tasks/i.test(text)) return { rows: [{ handover_id: this.task.handover_id }] }
    if (/select \* from handover_tasks/i.test(text)) return { rows: [this.task] }
    return { rows: [{
      id: 'handover-1', created_by_user_id: 'user-1', participants: [], shared_with_user_ids: [],
      transcription_metadata: null, analysis: null,
    }] }
  }
  async update(_table: unknown, _id: string, patch: Partial<HandoverTaskRow>) {
    this.patch = patch
    return { ...this.task, ...patch }
  }
}

class TaskCollisionDatabase {
  creates = 0
  updates = 0
  constructor(readonly existing: HandoverTaskRow) {}
  async transaction<T>(callback: (db: Database) => Promise<T>): Promise<T> {
    return callback(this as unknown as Database)
  }
  async find(table: any, id: string) {
    return 'reminder_enabled' in table && id === this.existing.id ? this.existing : null
  }
  async exec(statement: SqlStatement | string) {
    let text = typeof statement === 'string' ? statement : statement.text
    if (/select h\.\* from handovers/i.test(text)) {
      return { rows: [{
        id: 'allowed-handover', created_by_user_id: 'user-1', participants: [], shared_with_user_ids: [],
        transcription_metadata: null, analysis: null,
      }] }
    }
    return { rows: [] }
  }
  async create() { this.creates++; return null }
  async update() { this.updates++; return null }
}

describe('native data-table schema and queue', () => {
  it('maps every data-table-backed application table', () => {
    let names = [schema.users, schema.sessions, schema.usabilitySessions, schema.usabilityEvents, schema.shifts,
      schema.shiftSheetPatients, schema.handovers, schema.handoverAudio, schema.handoverJobs, schema.handoverRecordingUploads,
      schema.handoverPatients, schema.handoverTasks,
      schema.handoverBookmarks, schema.handoverAssignments].map(getTableName)
    assert.equal(names.length, 14)
    assert.equal(new Set(names).size, 14)
    assert.deepEqual(schema.handoverTaskPriorities, ['low', 'routine', 'medium', 'high', 'urgent'])
    assert.deepEqual(schema.handoverTaskStatuses, ['open', 'in_progress', 'done'])
    assert.deepEqual(schema.handoverTaskSources, ['transcript', 'uncertainty', 'history', 'manual'])
  })

  it('has an initial migration with the complete queue and session shape', async () => {
    let file = new URL('../../db/migrations/20261026000000_initial_schema/up.sql', import.meta.url)
    let downFile = new URL('../../db/migrations/20261026000000_initial_schema/down.sql', import.meta.url)
    let migration = await fs.readFile(file, 'utf8')
    let rollback = await fs.readFile(downFile, 'utf8')
    assert.match(migration, /create table handover_jobs/i)
    assert.match(migration, /create table usability_events/i)
    assert.match(migration, /payload jsonb not null/)
    assert.match(migration, /expires_at timestamptz not null/)
    assert.match(migration, /direction in \('incoming', 'intra-shift', 'outgoing'\)/)
    assert.match(migration, /priority in \('low', 'routine', 'medium', 'high', 'urgent'\)/)
    assert.match(migration, /status in \('open', 'in_progress', 'done'\)/)
    assert.match(migration, /source in \('transcript', 'uncertainty', 'history', 'manual'\)/)
    assert.match(
      migration,
      /create unique index handover_tasks_related_uncertainty_unique_idx\s+on handover_tasks\(handover_id, patient_key, related_uncertainty_id\)\s+where related_uncertainty_id is not null/i,
    )
    assert.match(migration, /create table resource_cleanup_outbox/i)
    assert.match(migration, /create table handover_recording_uploads/i)
    assert.match(migration, /primary key \(user_id, recording_upload_id\)/i)
    assert.match(migration, /for update skip locked|resource_cleanup_outbox_claim_idx/i)
    assert.doesNotMatch(migration, /\bowner_role\b/i)
    assert.equal((migration.match(/create table /gi) ?? []).length, 23)
    assert.match(rollback, /drop table if exists resource_cleanup_outbox/i)
    assert.match(rollback, /drop table if exists handover_recording_uploads/i)
    assert.equal((rollback.match(/drop table if exists /gi) ?? []).length, 23)
  })

  it('uses parameterized data-table SQL for enqueue and SKIP LOCKED claiming', async () => {
    let db = new RecordingDatabase()
    await enqueueHandoverJob(db as unknown as Database, {
      id: 'job-1', handoverId: 'handover-1', revision: 1, kind: 'create', payload: {},
    })
    await claimNextHandoverJob(db as unknown as Database, { workerId: 'worker-1', lockMs: 30_000 })
    let sql = db.statements.map((statement) => statement.text).join('\n')
    assert.match(sql, /insert into handover_jobs/)
    assert.match(sql, /for update of candidate_jobs, candidate_handovers skip locked/)
    assert.match(sql, /privacy_handover\.privacy_mode_floor = 'local-first'[\s\S]*jsonb_set\(payload/)
    let familyLock = db.statements.findIndex((statement) => statement.text.includes('pg_advisory_xact_lock'))
    let handoverLock = db.statements.findIndex((statement) => /from handovers where id = .*for update/s.test(statement.text))
    assert.ok(familyLock >= 0 && handoverLock > familyLock)
    assert.ok(db.statements.every((statement) => statement.values.length > 0))
  })

  it('ratchets a stale concurrent cloud enqueue to the locked local-first floor', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let userId = randomUUID(), handoverId = randomUUID(), localJobId = randomUUID(), cloudJobId = randomUUID()
    let releaseFirst!: () => void
    let firstMayCommit!: () => void
    let secondEntered!: () => void
    let releaseFirstPromise = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstMayCommitPromise = new Promise<void>((resolve) => { firstMayCommit = resolve })
    let secondEnteredPromise = new Promise<void>((resolve) => { secondEntered = resolve })
    try {
      await runtime.db.exec(sql`insert into users(id,full_name,occupation,department) values(${userId},'Privacy Floor','Nurse','Ward')`)
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,title,source_department,context_type,consent_mode,
          priority_preference,processing_status,version,created_at,updated_at
        ) values(
          ${handoverId},${userId},'Concurrent privacy floor','Ward','shift','verbal',
          'standard','queued',1,now(),now()
        )
      `)

      let localDb = new Proxy(runtime.db, {
        get(target, property, receiver) {
          if (property === 'transaction') {
            return async (callback: (tx: Parameters<Parameters<typeof runtime.db.transaction>[0]>[0]) => Promise<unknown>) => target.transaction(async (tx) => {
              let result = await callback(tx)
              firstMayCommit()
              await releaseFirstPromise
              return result
            })
          }
          let value = Reflect.get(target, property, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      let cloudDb = new Proxy(runtime.db, {
        get(target, property, receiver) {
          if (property === 'transaction') {
            return async (callback: (tx: Parameters<Parameters<typeof runtime.db.transaction>[0]>[0]) => Promise<unknown>) => target.transaction(async (tx) => {
              secondEntered()
              return callback(tx)
            })
          }
          let value = Reflect.get(target, property, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })

      let localEnqueue = enqueueHandoverJob(localDb, {
        id: localJobId,
        handoverId,
        revision: 1,
        kind: 'create',
        payload: { privacyMode: 'local-first', privacyPolicyVersion: 1 },
      })
      await firstMayCommitPromise
      let staleCloudEnqueue = enqueueHandoverJob(cloudDb, {
        id: cloudJobId,
        handoverId,
        revision: 2,
        kind: 'extend',
        payload: { privacyMode: 'cloud', privacyPolicyVersion: 1 },
      })
      await secondEnteredPromise
      releaseFirst()
      await Promise.all([localEnqueue, staleCloudEnqueue])

      let handover = (await runtime.db.exec(sql`
        select privacy_mode_floor from handovers where id=${handoverId}
      `)).rows?.[0]
      let jobs = (await runtime.db.exec(sql`
        select id, payload from handover_jobs where handover_id=${handoverId} order by revision
      `)).rows ?? []
      assert.equal(handover?.privacy_mode_floor, 'local-first')
      assert.deepEqual(jobs.map((job) => (job.payload as { privacyMode?: string }).privacyMode), [
        'local-first',
        'local-first',
      ])
    } finally {
      releaseFirst()
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.db.exec(sql`delete from users where id=${userId}`)
      await runtime.close()
    }
  })

  it('ratchets existing recipient copies and their queued jobs when the source becomes local-first', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let userId = randomUUID(), sourceId = randomUUID(), copyId = randomUUID()
    let sourceJobId = randomUUID(), copyJobId = randomUUID()
    try {
      await runtime.db.exec(sql`
        insert into users(id,full_name,occupation,department)
        values(${userId},'Privacy Family','Nurse','Ward')
      `)
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,source_handover_id,title,source_department,context_type,
          consent_mode,priority_preference,processing_status,version,current_job_id,created_at,updated_at
        ) values
          (${sourceId},${userId},null,'Source','Ward','shift','verbal','standard','queued',1,null,now(),now()),
          (${copyId},${userId},${sourceId},'Copy','Ward','shift','verbal','standard','queued',1,${copyJobId},now(),now())
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(id,handover_id,revision,kind,status,attempts,payload,created_at,updated_at)
        values(${copyJobId},${copyId},1,'create','queued',0,
          '{"privacyMode":"cloud","privacyPolicyVersion":1}'::jsonb,now(),now())
      `)

      await enqueueHandoverJob(runtime.db, {
        id: sourceJobId,
        handoverId: sourceId,
        revision: 1,
        kind: 'create',
        payload: { privacyMode: 'local-first', privacyPolicyVersion: 1 },
      })

      let handovers = (await runtime.db.exec(sql`
        select id, privacy_mode_floor from handovers
        where id in (${sourceId}, ${copyId}) order by id
      `)).rows ?? []
      let jobs = (await runtime.db.exec(sql`
        select id, payload from handover_jobs
        where id in (${sourceJobId}, ${copyJobId}) order by id
      `)).rows ?? []
      assert.deepEqual(handovers.map((row) => row.privacy_mode_floor), ['local-first', 'local-first'])
      assert.deepEqual(
        jobs.map((row) => (row.payload as { privacyMode?: string }).privacyMode),
        ['local-first', 'local-first'],
      )

      await runtime.db.exec(sql`delete from handovers where id=${sourceId}`)
      let orphan = (await runtime.db.exec(sql`
        select source_handover_id, privacy_mode_floor from handovers where id=${copyId}
      `)).rows?.[0]
      assert.equal(orphan?.source_handover_id, sourceId)
      assert.equal(orphan?.privacy_mode_floor, 'local-first')
    } finally {
      await runtime.db.exec(sql`delete from handovers where id=${copyId} or id=${sourceId}`)
      await runtime.db.exec(sql`delete from users where id=${userId}`)
      await runtime.close()
    }
  })

  it('prepares every queued analysis-only cleanup before ratcheting a privacy family', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let userId = randomUUID(), sourceId = randomUUID(), promotedCopyId = randomUUID(), rebuiltCopyId = randomUUID()
    let promotedOriginId = randomUUID(), rebuiltOriginId = randomUUID()
    let promotedJobId = randomUUID(), rebuiltJobId = randomUUID(), promotedCleanupId = randomUUID()
    let promotedBlob = `audio/${randomUUID()}.webm`, rebuiltBlob = `audio/${randomUUID()}.webm`
    try {
      await runtime.db.exec(sql`insert into users(id,full_name,occupation,department) values(${userId},'Family Cleanup','Nurse','Ward')`)
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,source_handover_id,title,source_department,context_type,
          consent_mode,priority_preference,transcript,transcription_metadata,
          processing_status,version,current_job_id,created_at,updated_at
        ) values
          (${sourceId},${userId},null,'Cleanup source','Ward','shift','verbal','standard',
            'Durable source transcript','{"mocked":false}'::jsonb,'completed',2,null,now(),now()),
          (${promotedCopyId},${userId},${sourceId},'Promoted copy','Ward','shift','verbal','standard',
            'Durable source transcript','{"mocked":false}'::jsonb,'queued',1,${promotedJobId},now(),now()),
          (${rebuiltCopyId},${userId},${sourceId},'Rebuilt copy','Ward','shift','verbal','standard',
            'Durable source transcript','{"mocked":false}'::jsonb,'queued',2,${rebuiltJobId},now(),now())
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(id,handover_id,revision,kind,status,attempts,payload,created_at,completed_at,updated_at)
        values
          (${promotedOriginId},${sourceId},1,'create','completed',1,
            ${JSON.stringify({ audioBlobKey: promotedBlob })}::jsonb,now(),now(),now()),
          (${rebuiltOriginId},${sourceId},2,'extend','completed',1,
            ${JSON.stringify({ audioBlobKey: rebuiltBlob })}::jsonb,now(),now(),now()),
          (${promotedJobId},${promotedCopyId},1,'create','queued',0,
            ${JSON.stringify({
              retryFrom: 'analysis', audioCleanupJobId: promotedOriginId,
              audioBlobKey: promotedBlob, audioOriginalFilename: 'promoted.webm',
              privacyMode: 'cloud', privacyPolicyVersion: 1,
            })}::jsonb,now(),null,now()),
          (${rebuiltJobId},${rebuiltCopyId},2,'extend','queued',0,
            ${JSON.stringify({
              retryFrom: 'analysis', retrySegmentCount: 1, audioCleanupJobId: rebuiltOriginId,
              audioBlobKey: rebuiltBlob, audioOriginalFilename: 'rebuilt.webm',
              privacyMode: 'cloud', privacyPolicyVersion: 1,
            })}::jsonb,now(),null,now())
      `)
      await runtime.db.exec(sql`
        insert into transcription_runs(id,handover_id,job_id,revision,provider,status,metadata,started_at,completed_at)
        values
          (${randomUUID()},${sourceId},${promotedOriginId},1,'assemblyai','completed','{}'::jsonb,now(),now()),
          (${randomUUID()},${sourceId},${rebuiltOriginId},2,'assemblyai','completed','{}'::jsonb,now(),now())
      `)
      await runtime.db.exec(sql`
        insert into resource_cleanup_outbox(
          id,kind,resource_id,blob_key,handover_id,job_id,revision,deletion_required,status,
          attempts,next_retry_at,created_at,updated_at
        ) values(
          ${promotedCleanupId},'local-audio-object',${promotedBlob},${promotedBlob},
          ${sourceId},${promotedOriginId},1,false,'queued',0,now(),now(),now()
        )
      `)

      await ratchetHandoverPrivacyFamily(runtime.db, { handoverId: sourceId })

      let jobs = (await runtime.db.exec(sql`
        select id,payload from handover_jobs where id in (${promotedJobId},${rebuiltJobId}) order by id
      `)).rows ?? []
      for (let row of jobs) {
        let payload = row.payload as Record<string, unknown>
        assert.equal(payload.privacyMode, 'local-first')
        assert.equal(payload.privacyPolicyVersion, 1)
        assert.equal(payload.audioBlobKey, undefined)
        assert.equal(payload.audioOriginalFilename, undefined)
        assert.ok(payload.audioCleanupJobId === promotedOriginId || payload.audioCleanupJobId === rebuiltOriginId)
      }
      let cleanup = (await runtime.db.exec(sql`
        select job_id,deletion_required from resource_cleanup_outbox
        where job_id in (${promotedOriginId},${rebuiltOriginId}) order by job_id
      `)).rows ?? []
      assert.deepEqual(cleanup, [
        { job_id: promotedOriginId, deletion_required: true },
        { job_id: rebuiltOriginId, deletion_required: true },
      ].sort((left, right) => left.job_id.localeCompare(right.job_id)))
      assert.deepEqual((await runtime.db.exec(sql`
        select privacy_mode_floor from handovers
        where id in (${sourceId},${promotedCopyId},${rebuiltCopyId}) order by id
      `)).rows?.map((row) => row.privacy_mode_floor), ['local-first', 'local-first', 'local-first'])
    } finally {
      await runtime.db.exec(sql`delete from resource_cleanup_outbox where job_id in (${promotedOriginId},${rebuiltOriginId})`)
      await runtime.db.exec(sql`delete from handovers where id in (${promotedCopyId},${rebuiltCopyId},${sourceId})`)
      await runtime.db.exec(sql`delete from users where id=${userId}`)
      await runtime.close()
    }
  })

  it('rolls back the whole family ratchet when an analysis-only cleanup cannot be proven', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let userId = randomUUID(), handoverId = randomUUID(), jobId = randomUUID()
    let blobKey = `audio/${randomUUID()}.webm`
    try {
      await runtime.db.exec(sql`insert into users(id,full_name,occupation,department) values(${userId},'Unsafe Family','Nurse','Ward')`)
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,title,source_department,context_type,consent_mode,
          priority_preference,transcript,transcription_metadata,processing_status,version,current_job_id
        ) values(
          ${handoverId},${userId},'Unsafe cleanup','Ward','shift','verbal','standard',
          'Unproven transcript','{"mocked":false}'::jsonb,'queued',1,${jobId}
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(id,handover_id,revision,kind,status,payload)
        values(${jobId},${handoverId},1,'create','queued',
          ${JSON.stringify({ retryFrom: 'analysis', audioBlobKey: blobKey, privacyMode: 'cloud', privacyPolicyVersion: 1 })}::jsonb)
      `)

      await assert.rejects(
        () => ratchetHandoverPrivacyFamily(runtime.db, { handoverId }),
        /safely prepare source recording deletion/,
      )
      assert.deepEqual((await runtime.db.exec(sql`
        select h.privacy_mode_floor,j.payload ->> 'privacyMode' as job_mode
        from handovers h join handover_jobs j on j.id=${jobId} where h.id=${handoverId}
      `)).rows?.[0], { privacy_mode_floor: 'cloud', job_mode: 'cloud' })
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int as count from resource_cleanup_outbox where blob_key=${blobKey}
      `)).rows?.[0]?.count, 0)
    } finally {
      await runtime.db.exec(sql`delete from resource_cleanup_outbox where blob_key=${blobKey}`)
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.db.exec(sql`delete from users where id=${userId}`)
      await runtime.close()
    }
  })

  it('holds the shared family lock before either sibling enqueue can lock its handover row', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let userId = randomUUID(), sourceId = randomUUID(), copyId = randomUUID()
    let sourceJobId = randomUUID(), copyJobId = randomUUID()
    let releaseSource!: () => void
    let sourceRowLocked!: () => void
    let copyRowLocked!: () => void
    let releaseSourcePromise = new Promise<void>((resolve) => { releaseSource = resolve })
    let sourceRowLockedPromise = new Promise<void>((resolve) => { sourceRowLocked = resolve })
    let copyRowLockedPromise = new Promise<void>((resolve) => { copyRowLocked = resolve })
    let sourceEnqueue: Promise<unknown> | null = null
    let copyEnqueue: Promise<unknown> | null = null
    try {
      await runtime.db.exec(sql`insert into users(id,full_name,occupation,department) values(${userId},'Family Lock','Nurse','Ward')`)
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,source_handover_id,title,source_department,context_type,
          consent_mode,priority_preference,processing_status,version,created_at,updated_at
        ) values
          (${sourceId},${userId},null,'Source lock','Ward','shift','verbal','standard','queued',1,now(),now()),
          (${copyId},${userId},${sourceId},'Copy lock','Ward','shift','verbal','standard','queued',1,now(),now())
      `)

      let barrierDatabase = (handoverId: string, onLocked: () => void, wait: Promise<void> | null) => new Proxy(runtime.db, {
        get(target, property, receiver) {
          if (property === 'transaction') {
            return async (callback: (tx: Parameters<Parameters<typeof runtime.db.transaction>[0]>[0]) => Promise<unknown>) => target.transaction(async (tx) => callback(new Proxy(tx, {
              get(transaction, transactionProperty, transactionReceiver) {
                if (transactionProperty === 'exec') {
                  return async (statement: SqlStatement | string) => {
                    let result = await transaction.exec(statement)
                    if (
                      typeof statement !== 'string'
                      && /select id, privacy_mode_floor, coalesce\(source_handover_id, id\).*for update/s.test(statement.text)
                      && statement.values.includes(handoverId)
                    ) {
                      onLocked()
                      if (wait) await wait
                    }
                    return result
                  }
                }
                let value = Reflect.get(transaction, transactionProperty, transactionReceiver)
                return typeof value === 'function' ? value.bind(transaction) : value
              },
            }) as typeof tx))
          }
          let value = Reflect.get(target, property, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })

      sourceEnqueue = enqueueHandoverJob(barrierDatabase(sourceId, sourceRowLocked, releaseSourcePromise), {
        id: sourceJobId,
        handoverId: sourceId,
        revision: 1,
        kind: 'create',
        payload: { privacyMode: 'local-first', privacyPolicyVersion: 1 },
      })
      await sourceRowLockedPromise
      copyEnqueue = enqueueHandoverJob(barrierDatabase(copyId, copyRowLocked, null), {
        id: copyJobId,
        handoverId: copyId,
        revision: 1,
        kind: 'create',
        payload: { privacyMode: 'local-first', privacyPolicyVersion: 1 },
      })
      let copyReachedRowLock = await Promise.race([
        copyRowLockedPromise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 75)),
      ])
      assert.equal(copyReachedRowLock, false)

      releaseSource()
      await Promise.all([sourceEnqueue, copyEnqueue])
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int as count from handover_jobs where id in (${sourceJobId},${copyJobId})
      `)).rows?.[0]?.count, 2)
    } finally {
      releaseSource()
      await Promise.allSettled([sourceEnqueue, copyEnqueue].filter((value): value is Promise<unknown> => value != null))
      await runtime.db.exec(sql`delete from handovers where id=${copyId} or id=${sourceId}`)
      await runtime.db.exec(sql`delete from users where id=${userId}`)
      await runtime.close()
    }
  })

  it('rejects invalid lease durations before querying Postgres', async () => {
    let db = new RecordingDatabase()
    await assert.rejects(() => claimNextHandoverJob(db as unknown as Database, { workerId: 'worker', lockMs: 0 }), /positive integer/)
    assert.equal(db.statements.length, 0)
  })

  it('preserves task priority, source, creation time, and uncertainty linkage on field edits', async () => {
    let db = new TaskUpdateDatabase()
    let dueAt = new Date('2026-07-14T05:30:00.000Z')
    let updated = await updateTaskFields(db as unknown as Database, {
      id: 'task-1', userId: 'user-1', title: 'Updated action', dueLabel: '14 Jul 2026, 3:30 PM', dueAt,
    })

    assert.equal(updated?.title, 'Updated action')
    assert.equal(updated?.due_label, '14 Jul 2026, 3:30 PM')
    assert.equal(updated?.due_at, dueAt)
    assert.equal(updated?.priority, 'urgent')
    assert.equal(updated?.source, 'uncertainty')
    assert.equal(updated?.related_uncertainty_id, 'uncertainty-1')
    assert.equal(updated?.created_at, db.task.created_at)
    assert.deepEqual(Object.keys(db.patch ?? {}).sort(), ['due_at', 'due_label', 'title', 'updated_at'])
  })

  it('refuses a colliding task id instead of overwriting or moving the existing task', async () => {
    let createdAt = new Date('2026-07-13T01:00:00.000Z')
    let existing: HandoverTaskRow = {
      id: 'known-task', handover_id: 'other-handover', patient_key: 'other-patient', title: 'Existing action',
      due_label: 'No due date set', due_at: null, priority: 'routine', status: 'open',
      reminder_enabled: false, carried_forward: false, source: 'manual', related_uncertainty_id: null,
      created_at: createdAt, updated_at: createdAt,
    }
    let db = new TaskCollisionDatabase(existing)
    let result = await createHandoverTask(db as unknown as Database, {
      ...existing,
      handover_id: 'allowed-handover',
      patient_key: 'patient-1',
      title: 'Attacker replacement',
      userId: 'user-1',
    })

    assert.equal(result, null)
    assert.equal(db.creates, 0)
    assert.equal(db.updates, 0)
    assert.equal(existing.handover_id, 'other-handover')
    assert.equal(existing.title, 'Existing action')
  })

  it('stores JSON arrays as JSON arrays through data-table lifecycle hooks', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime(), userId = randomUUID(), shiftId = randomUUID()
    try {
      await runtime.db.exec(sql`insert into users(id,full_name,occupation,department) values(${userId},'JSON Test','Nurse','Ward')`)
      let created = await createShift(runtime.db, {
        id: shiftId, created_by_user_id: userId, title: 'Lifecycle JSON', department: 'Ward',
        assigned_user_ids: ['assigned-user'], notes: '', patient_order: ['patient-1'], status: 'active',
      })
      assert.deepEqual(created.assigned_user_ids, ['assigned-user'])
      assert.deepEqual(created.patient_order, ['patient-1'])
      let raw = (await runtime.db.exec(sql`
        select jsonb_typeof(assigned_user_ids) assigned_type, jsonb_typeof(patient_order) patient_type
        from shifts where id=${shiftId}
      `)).rows?.[0]
      assert.equal(raw?.assigned_type, 'array')
      assert.equal(raw?.patient_type, 'array')
      let loaded = await getShiftForUser(runtime.db, shiftId, userId)
      assert.deepEqual(loaded?.patient_order, ['patient-1'])
    } finally {
      await runtime.db.exec(sql`delete from shifts where id=${shiftId}`)
      await runtime.db.exec(sql`delete from users where id=${userId}`)
      await runtime.close()
    }
  })

  it('persists a concrete task due date through the authorised task update path', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime(), userId = randomUUID(), handoverId = randomUUID(), taskId = randomUUID()
    let dueAt = new Date('2026-07-14T05:30:00.000Z')
    try {
      await runtime.db.exec(sql`insert into users(id,full_name,occupation,department) values(${userId},'Task Date Test','Nurse','Ward')`)
      await runtime.db.exec(sql`
        insert into handovers(
          id, created_by_user_id, title, source_department, context_type, consent_mode,
          priority_preference, processing_status, version, created_at, updated_at
        ) values(
          ${handoverId}, ${userId}, 'Task date handover', 'Ward', 'shift-handover',
          'verbal', 'balanced', 'completed', 1, now(), now()
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_tasks(
          id, handover_id, patient_key, title, due_label, due_at,
          priority, status, reminder_enabled, carried_forward, source, created_at, updated_at
        ) values(
          ${taskId}, ${handoverId}, 'patient-1', 'Review oxygen target',
          'No due date set', null, 'medium', 'open', false, false, 'manual', now(), now()
        )
      `)

      let updated = await updateTaskFields(runtime.db, {
        id: taskId,
        userId,
        dueAt,
        dueLabel: '14 Jul 2026, 3:30 PM',
      })
      let persisted = (await runtime.db.exec(sql`
        select due_at, due_label from handover_tasks where id=${taskId}
      `)).rows?.[0]

      assert.equal(updated?.due_at?.toISOString(), dueAt.toISOString())
      assert.equal(persisted?.due_at instanceof Date ? persisted.due_at.toISOString() : String(persisted?.due_at), dueAt.toISOString())
      assert.equal(persisted?.due_label, '14 Jul 2026, 3:30 PM')
    } finally {
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.db.exec(sql`delete from users where id=${userId}`)
      await runtime.close()
    }
  })

  it('creates one task for concurrent uncertainty submissions while allowing ordinary manual tasks', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let userId = randomUUID(), handoverId = randomUUID(), uncertaintyId = randomUUID()
    let patientKey = 'patient-1'
    let now = new Date('2026-07-16T01:00:00.000Z')
    let task = (id: string, relatedUncertaintyId: string | null): HandoverTaskRow & { userId: string } => ({
      id,
      handover_id: handoverId,
      patient_key: patientKey,
      title: relatedUncertaintyId ? 'Verify oxygen target' : `Manual task ${id}`,
      due_label: 'No due date set',
      due_at: null,
      priority: 'routine',
      status: 'open',
      reminder_enabled: false,
      carried_forward: false,
      source: relatedUncertaintyId ? 'uncertainty' : 'manual',
      related_uncertainty_id: relatedUncertaintyId,
      created_at: now,
      updated_at: now,
      userId,
    })
    try {
      await runtime.db.exec(sql`
        insert into users(id, full_name, occupation, department)
        values(${userId}, 'Task Idempotency Test', 'Nurse', 'Ward')
      `)
      await runtime.db.exec(sql`
        insert into handovers(
          id, created_by_user_id, title, source_department, context_type, consent_mode,
          priority_preference, processing_status, analysis, version, created_at, updated_at
        ) values(
          ${handoverId}, ${userId}, 'Task idempotency handover', 'Ward', 'shift-handover',
          'agreed', 'balanced', 'completed',
          ${JSON.stringify({ patients: [{ patientKey, uncertainties: [{ id: uncertaintyId }] }] })}::jsonb,
          1, now(), now()
        )
      `)

      let [first, replay] = await Promise.all([
        createHandoverTask(runtime.db, task(randomUUID(), uncertaintyId)),
        createHandoverTask(runtime.db, task(randomUUID(), uncertaintyId)),
      ])
      let uncertaintyRows = (await runtime.db.exec(sql`
        select id from handover_tasks
        where handover_id = ${handoverId} and patient_key = ${patientKey}
          and related_uncertainty_id = ${uncertaintyId}
      `)).rows ?? []

      assert.ok(first)
      assert.ok(replay)
      assert.equal(first.id, replay.id)
      assert.equal(uncertaintyRows.length, 1)
      assert.equal(uncertaintyRows[0]!.id, first.id)

      await runtime.db.exec(sql`
        update handover_tasks set
          title = 'Clinician-reviewed verification wording', priority = 'high',
          status = 'in_progress', reminder_enabled = true
        where id = ${first.id}
      `)
      let duplicateProjection = await runtime.db.exec(sql`
        insert into handover_tasks(
          id, handover_id, patient_key, title, due_label, due_at,
          priority, status, reminder_enabled, carried_forward, source,
          related_uncertainty_id, created_at, updated_at
        ) values(
          ${randomUUID()}, ${handoverId}, ${patientKey}, 'Different model wording',
          'No due date set', null, 'low', 'open', false, false, 'transcript',
          ${uncertaintyId}, now(), now()
        ) on conflict do nothing returning id
      `)
      let preserved = (await runtime.db.exec(sql`
        select title, priority, status, reminder_enabled
        from handover_tasks where id = ${first.id}
      `)).rows?.[0]

      assert.equal(duplicateProjection.rows?.length ?? 0, 0)
      assert.deepEqual(preserved, {
        title: 'Clinician-reviewed verification wording',
        priority: 'high',
        status: 'in_progress',
        reminder_enabled: true,
      })

      let manualIds = [randomUUID(), randomUUID()]
      let manualTasks = await Promise.all(manualIds.map((id) => createHandoverTask(runtime.db, task(id, null))))
      let manualRows = (await runtime.db.exec(sql`
        select id from handover_tasks
        where handover_id = ${handoverId} and patient_key = ${patientKey}
          and related_uncertainty_id is null
        order by id
      `)).rows ?? []

      assert.deepEqual(manualTasks.map((item) => item?.id).sort(), manualIds.sort())
      assert.deepEqual(manualRows.map((row) => String(row.id)).sort(), manualIds.sort())
    } finally {
      await runtime.db.exec(sql`delete from handovers where id = ${handoverId}`)
      await runtime.db.exec(sql`delete from users where id = ${userId}`)
      await runtime.close()
    }
  })

  it('queues recommenced handovers behind the active revision and promotes them in order', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime(), userId = randomUUID(), handoverId = randomUUID()
    let activeJobId = randomUUID(), firstContinuationId = randomUUID(), secondContinuationId = randomUUID()
    let workerId = `worker-${randomUUID()}`
    try {
      await runtime.db.exec(sql`
        insert into users(id, full_name, occupation, department)
        values(${userId}, 'Extension Guard Test', 'Nurse', 'Ward')
      `)
      await runtime.db.exec(sql`
        insert into handovers(
          id, created_by_user_id, title, source_department, context_type, consent_mode,
          priority_preference, processing_status, version, current_job_id,
          processing_lease_until, created_at, updated_at
        ) values(
          ${handoverId}, ${userId}, 'Active handover', 'Ward', 'shift-handover',
          'verbal', 'balanced', 'analysing', 1, ${activeJobId},
          now() + interval '5 minutes', now(), now()
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(
          id, handover_id, revision, kind, status, attempts, locked_by, locked_until,
          payload, created_at, started_at, updated_at
        ) values(
          ${activeJobId}, ${handoverId}, 1, 'create', 'running', 1, ${workerId},
          now() + interval '5 minutes', '{}'::jsonb, now() - interval '1 minute',
          now() - interval '1 minute', now()
        )
      `)

      await extendHandover(runtime.db, {
        id: handoverId,
        userId,
        jobId: firstContinuationId,
        payload: { manualTranscript: 'First queued continuation.' },
      })
      await extendHandover(runtime.db, {
        id: handoverId,
        userId,
        jobId: secondContinuationId,
        payload: { manualTranscript: 'Second queued continuation.' },
      })
      let state = (await runtime.db.exec(sql`
        select version, processing_status, current_job_id
        from handovers where id = ${handoverId}
      `)).rows?.[0]
      assert.deepEqual(state, { version: 1, processing_status: 'analysing', current_job_id: activeJobId })
      let queued = (await runtime.db.exec(sql`
        select id, revision, status from handover_jobs
        where handover_id = ${handoverId} and id <> ${activeJobId}
        order by revision
      `)).rows
      assert.deepEqual(queued, [
        { id: firstContinuationId, revision: 2, status: 'queued' },
        { id: secondContinuationId, revision: 3, status: 'queued' },
      ])

      assert.equal(await completeHandoverJob(runtime.db, { jobId: activeJobId, workerId }), true)
      state = (await runtime.db.exec(sql`
        select version, processing_status, current_job_id from handovers where id = ${handoverId}
      `)).rows?.[0]
      assert.deepEqual(state, { version: 2, processing_status: 'queued', current_job_id: firstContinuationId })

      let claimed = await claimNextHandoverJob(runtime.db, { workerId, lockMs: 30_000 })
      assert.equal(claimed?.id, firstContinuationId)
      assert.equal(await acquireHandoverJobLease(runtime.db, { handoverId, jobId: firstContinuationId, lockMs: 30_000 }), true)
      assert.equal(await completeHandoverJob(runtime.db, { jobId: firstContinuationId, workerId }), true)
      state = (await runtime.db.exec(sql`
        select version, processing_status, current_job_id from handovers where id = ${handoverId}
      `)).rows?.[0]
      assert.deepEqual(state, { version: 3, processing_status: 'queued', current_job_id: secondContinuationId })
    } finally {
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.db.exec(sql`delete from users where id=${userId}`)
      await runtime.close()
    }
  })

  it('preserves a failed job for audit while allowing the next queued revision to advance', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime(), handoverId = randomUUID(), jobId = randomUUID(), nextJobId = randomUUID()
    let workerId = `worker-${randomUUID()}`
    try {
      await runtime.db.exec(sql`
        insert into handovers(
          id, title, source_department, context_type, consent_mode, priority_preference,
          processing_status, processing_started_at, version, created_at, updated_at
        ) values(
          ${handoverId}, 'Queue failure invariant', 'Test ward', 'shift-handover',
          'verbal', 'balanced', 'analysing', now(), 1, now(), now()
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(
          id, handover_id, revision, kind, status, attempts, locked_by, locked_until,
          payload, created_at, started_at, updated_at
        ) values(
          ${jobId}, ${handoverId}, 1, 'create', 'running', 1, ${workerId},
          now() + interval '30 seconds', '{}'::jsonb, now(), now(), now()
        )
      `)
      await runtime.db.exec(sql`
        update handovers set current_job_id = ${jobId}, processing_lease_until = now() + interval '30 seconds'
        where id = ${handoverId}
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(
          id, handover_id, revision, kind, status, attempts, payload, created_at, updated_at
        ) values(
          ${nextJobId}, ${handoverId}, 2, 'extend', 'queued', 0,
          '{"manualTranscript":"Next revision"}'::jsonb, now() + interval '1 second', now()
        )
      `)

      assert.equal(await failHandoverJob(runtime.db, {
        handoverId,
        jobId,
        workerId,
        errorMessage: 'Controlled test failure.',
      }), true)

      let state = (await runtime.db.exec(sql`
        select h.current_job_id, h.processing_status, h.processing_lease_until,
          j.status as job_status, j.locked_by, j.locked_until
        from handovers h join handover_jobs j on j.id = h.current_job_id
        where h.id = ${handoverId}
      `)).rows?.[0]
      assert.equal(state?.current_job_id, jobId)
      assert.equal(state?.processing_status, 'failed')
      assert.equal(state?.processing_lease_until, null)
      assert.equal(state?.job_status, 'failed')
      assert.equal(state?.locked_by, null)
      assert.equal(state?.locked_until, null)

      let claimed = await claimNextHandoverJob(runtime.db, { workerId, lockMs: 30_000 })
      assert.equal(claimed?.id, nextJobId)
      assert.equal(await acquireHandoverJobLease(runtime.db, {
        handoverId,
        jobId: nextJobId,
        lockMs: 30_000,
      }), true)
      state = (await runtime.db.exec(sql`
        select h.current_job_id, h.processing_status, j.status as job_status
        from handovers h join handover_jobs j on j.id = h.current_job_id
        where h.id = ${handoverId}
      `)).rows?.[0]
      assert.equal(state?.current_job_id, nextJobId)
      assert.equal(state?.processing_status, 'queued')
      assert.equal(state?.job_status, 'running')
    } finally {
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.close()
    }
  })

  it('retries into a fresh same-revision job and preserves the failed row', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let handoverId = randomUUID(), failedJobId = randomUUID(), retryJobId = randomUUID(), laterJobId = randomUUID()
    try {
      await runtime.db.exec(sql`
        insert into handovers(
          id, title, source_department, context_type, consent_mode, priority_preference,
          transcript, transcription_metadata, processing_status, version, current_job_id,
          created_at, updated_at
        ) values(
          ${handoverId}, 'Retry invariant', 'Test ward', 'shift-handover', 'verbal', 'balanced',
          'Persisted transcript', '{"provider":"assemblyai"}'::jsonb, 'failed', 1, null,
          now(), now()
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(
          id, handover_id, revision, kind, status, attempts, payload, created_at, failed_at, updated_at, error_message
        ) values(
          ${failedJobId}, ${handoverId}, 1, 'create', 'failed', 2,
          '{"audioBlobKey":"audio/retry.webm"}'::jsonb, now(), now(), now(), 'Analysis failed.'
        ),(
          ${laterJobId}, ${handoverId}, 2, 'extend', 'queued', 0,
          '{"manualTranscript":"Later continuation"}'::jsonb, now() + interval '1 second', null, now(), null
        )
      `)
      await runtime.db.exec(sql`update handovers set current_job_id = ${failedJobId} where id = ${handoverId}`)
      await runtime.db.exec(sql`
        insert into transcription_runs(
          id, handover_id, job_id, revision, provider, status, metadata, started_at, completed_at
        ) values(
          ${randomUUID()}, ${handoverId}, ${failedJobId}, 1, 'assemblyai', 'completed',
          '{"segmentCount":3}'::jsonb, now(), now()
        )
      `)

      let retry = await retryFailedHandoverJob(runtime.db, {
        id: retryJobId,
        handoverId,
      })
      assert.equal(retry?.id, retryJobId)
      assert.equal(retry?.revision, 1)
      assert.equal(retry?.attempts, 0)
      assert.equal(retry?.payload.retryFrom, 'analysis')
      assert.equal(retry?.payload.retrySegmentCount, undefined)

      let jobs = (await runtime.db.exec(sql`
        select id, revision, status, attempts from handover_jobs
        where handover_id = ${handoverId} order by revision, created_at
      `)).rows
      assert.deepEqual(jobs, [
        { id: failedJobId, revision: 1, status: 'failed', attempts: 2 },
        { id: retryJobId, revision: 1, status: 'queued', attempts: 0 },
        { id: laterJobId, revision: 2, status: 'queued', attempts: 0 },
      ])
      let state = (await runtime.db.exec(sql`
        select current_job_id, version, processing_status, error_message from handovers where id = ${handoverId}
      `)).rows?.[0]
      assert.deepEqual(state, {
        current_job_id: retryJobId,
        version: 1,
        processing_status: 'queued',
        error_message: null,
      })
      assert.equal(await retryFailedHandoverJob(runtime.db, {
        id: randomUUID(),
        handoverId,
      }), null)
      assert.equal(await runtime.db.count(schema.handoverJobs, { where: { handover_id: handoverId } }), 3)
    } finally {
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.close()
    }
  })

  it('rejects a cloud-to-local raw-audio retry before ratcheting on remote storage', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let handoverId = randomUUID(), failedJobId = randomUUID()
    try {
      await runtime.db.exec(sql`
        insert into handovers(
          id,title,source_department,context_type,consent_mode,priority_preference,
          processing_status,privacy_mode_floor,version,current_job_id,created_at,updated_at
        ) values(
          ${handoverId},'Remote storage retry','Test ward','shift-handover','verbal','balanced',
          'failed','cloud',1,null,now(),now()
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(
          id,handover_id,revision,kind,status,attempts,payload,created_at,failed_at,updated_at,error_message
        ) values(
          ${failedJobId},${handoverId},1,'create','failed',1,
          ${JSON.stringify({
            audioBlobKey: `audio/${randomUUID()}.webm`,
            privacyMode: 'cloud',
            privacyPolicyVersion: 1,
          })}::jsonb,now(),now(),now(),'Transcription failed.'
        )
      `)
      await runtime.db.exec(sql`
        update handovers set current_job_id=${failedJobId} where id=${handoverId}
      `)

      await assert.rejects(() => retryFailedHandoverJob(runtime.db, {
        id: randomUUID(),
        handoverId,
        privacy: { privacyMode: 'local-first', privacyPolicyVersion: 1 },
        localFirstAudioStorageCompatible: false,
      }), /Local-first audio requires workstation-local filesystem storage/)

      let state = (await runtime.db.exec(sql`
        select privacy_mode_floor,processing_status,current_job_id from handovers where id=${handoverId}
      `)).rows?.[0]
      assert.deepEqual(state, {
        privacy_mode_floor: 'cloud',
        processing_status: 'failed',
        current_job_id: failedJobId,
      })
      assert.equal(await runtime.db.count(schema.handoverJobs, {
        where: { handover_id: handoverId },
      }), 1)
    } finally {
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.close()
    }
  })

  it('upgrades a cloud analysis retry and reconstructs mandatory cleanup from exact transcription provenance', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let handoverId = randomUUID(), failedJobId = randomUUID(), retryJobId = randomUUID()
    let blobKey = `audio/${randomUUID()}.webm`
    try {
      await runtime.db.exec(sql`
        insert into handovers(
          id,title,source_department,context_type,consent_mode,priority_preference,
          audio_blob_key,transcript,transcription_metadata,processing_status,version,current_job_id,
          created_at,updated_at
        ) values(
          ${handoverId},'Local-first retry','Test ward','shift-handover','verbal','balanced',
          ${blobKey},'Persisted transcript','{"mocked":false}'::jsonb,'failed',1,${failedJobId},now(),now()
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(
          id,handover_id,revision,kind,status,attempts,payload,created_at,failed_at,updated_at,error_message
        ) values(
          ${failedJobId},${handoverId},1,'create','failed',1,
          ${JSON.stringify({
            audioBlobKey: blobKey,
            audioOriginalFilename: 'retry.webm',
            audioCleanupJobId: failedJobId,
            retryFrom: 'analysis',
            privacyMode: 'cloud',
            privacyPolicyVersion: 1,
          })}::jsonb,now(),now(),now(),'Analysis failed.'
        )
      `)
      await runtime.db.exec(sql`
        insert into transcription_runs(
          id,handover_id,job_id,revision,provider,status,metadata,started_at,completed_at
        ) values(
          ${randomUUID()},${handoverId},${failedJobId},1,'assemblyai','completed',
          '{"mocked":false,"segmentCount":2}'::jsonb,now(),now()
        )
      `)

      let retry = await retryFailedHandoverJob(runtime.db, {
        id: retryJobId,
        handoverId,
        privacy: { privacyMode: 'local-first', privacyPolicyVersion: 1 },
      })
      assert.equal(retry?.payload.privacyMode, 'local-first')
      assert.equal(retry?.payload.privacyPolicyVersion, 1)
      assert.equal(retry?.payload.audioCleanupJobId, failedJobId)
      assert.equal(retry?.payload.audioBlobKey, undefined)
      assert.equal(retry?.payload.audioOriginalFilename, undefined)
      let cleanup = (await runtime.db.exec(sql`
        select handover_id,job_id,revision,blob_key,deletion_required,status
        from resource_cleanup_outbox where job_id=${failedJobId} and revision=1
      `)).rows?.[0]
      assert.deepEqual(cleanup, {
        handover_id: handoverId,
        job_id: failedJobId,
        revision: 1,
        blob_key: blobKey,
        deletion_required: true,
        status: 'queued',
      })
      assert.equal((await runtime.db.exec(sql`
        select privacy_mode_floor from handovers where id=${handoverId}
      `)).rows?.[0]?.privacy_mode_floor, 'local-first')
    } finally {
      await runtime.db.exec(sql`delete from resource_cleanup_outbox where job_id=${failedJobId}`)
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.close()
    }
  })

  it('promotes an existing retained-audio cleanup without duplicating it', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let handoverId = randomUUID(), failedJobId = randomUUID(), retryJobId = randomUUID(), cleanupId = randomUUID()
    let blobKey = `audio/${randomUUID()}.webm`
    try {
      await runtime.db.exec(sql`
        insert into handovers(
          id,title,source_department,context_type,consent_mode,priority_preference,
          audio_blob_key,transcript,transcription_metadata,processing_status,version,current_job_id,
          created_at,updated_at
        ) values(
          ${handoverId},'Retained audio retry','Test ward','shift-handover','verbal','balanced',
          ${blobKey},'Persisted transcript','{"mocked":false}'::jsonb,'failed',1,${failedJobId},now(),now()
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(
          id,handover_id,revision,kind,status,attempts,payload,created_at,failed_at,updated_at,error_message
        ) values(
          ${failedJobId},${handoverId},1,'create','failed',1,
          ${JSON.stringify({
            audioBlobKey: blobKey,
            audioCleanupJobId: failedJobId,
            retryFrom: 'analysis',
            privacyMode: 'cloud',
            privacyPolicyVersion: 1,
          })}::jsonb,now(),now(),now(),'Analysis failed.'
        )
      `)
      await runtime.db.exec(sql`
        insert into resource_cleanup_outbox(
          id,kind,resource_id,blob_key,handover_id,job_id,revision,deletion_required,status,
          attempts,next_retry_at,created_at,updated_at
        ) values(
          ${cleanupId},'local-audio-object',${blobKey},${blobKey},${handoverId},${failedJobId},1,
          false,'queued',0,now(),now(),now()
        )
      `)

      let retry = await retryFailedHandoverJob(runtime.db, {
        id: retryJobId,
        handoverId,
        privacy: { privacyMode: 'local-first', privacyPolicyVersion: 1 },
      })
      assert.equal(retry?.payload.audioCleanupJobId, failedJobId)
      assert.equal(retry?.payload.audioBlobKey, undefined)
      let cleanup = (await runtime.db.exec(sql`
        select id,deletion_required from resource_cleanup_outbox where job_id=${failedJobId} and revision=1
      `)).rows
      assert.deepEqual(cleanup, [{ id: cleanupId, deletion_required: true }])
    } finally {
      await runtime.db.exec(sql`delete from resource_cleanup_outbox where job_id=${failedJobId}`)
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.close()
    }
  })

  it('preserves and proves every cleanup dependency when retrying a failed explicit privacy rerun', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let handoverId = randomUUID(), failedJobId = randomUUID(), retryJobId = randomUUID()
    let firstCleanupJobId = randomUUID(), secondCleanupJobId = randomUUID()
    let firstCleanupId = randomUUID(), secondCleanupId = randomUUID()
    let firstBlobKey = `audio/${randomUUID()}.webm`, secondBlobKey = `audio/${randomUUID()}.webm`
    let dependencies = [
      { jobId: firstCleanupJobId, revision: 1 },
      { jobId: secondCleanupJobId, revision: 2 },
    ]
    try {
      await runtime.db.exec(sql`
        insert into handovers(
          id,title,source_department,context_type,consent_mode,priority_preference,
          transcript,transcription_metadata,processing_status,privacy_mode_floor,
          version,current_job_id,created_at,updated_at
        ) values(
          ${handoverId},'Retry privacy rerun','Test ward','shift-handover','verbal','balanced',
          'Persisted full transcript','{"engine":"omi-medical-edge-1:mlx","mocked":false}'::jsonb,
          'failed','local-first',2,${failedJobId},now(),now()
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(
          id,handover_id,revision,kind,status,attempts,payload,
          created_at,failed_at,updated_at,error_message
        ) values(
          ${failedJobId},${handoverId},2,'create','failed',1,
          ${JSON.stringify({
            retryFrom: 'analysis',
            privacyMode: 'local-first',
            privacyPolicyVersion: 1,
            audioCleanupDependencies: dependencies,
          })}::jsonb,now(),now(),now(),'Analysis failed.'
        )
      `)
      await runtime.db.exec(sql`
        insert into resource_cleanup_outbox(
          id,kind,resource_id,blob_key,handover_id,job_id,revision,status,
          attempts,outcome,deletion_required,completed_at
        ) values(
          ${firstCleanupId},'local-audio-object',${firstBlobKey},${firstBlobKey},
          ${handoverId},${firstCleanupJobId},1,'completed',1,'deleted',true,now()
        )
      `)

      await assert.rejects(() => retryFailedHandoverJob(runtime.db, {
        id: retryJobId,
        handoverId,
      }), /safely prepare source recording deletion/)
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int as count from handover_jobs where id=${retryJobId}
      `)).rows?.[0]?.count, 0)

      await runtime.db.exec(sql`
        insert into resource_cleanup_outbox(
          id,kind,resource_id,blob_key,handover_id,job_id,revision,status,
          attempts,outcome,deletion_required,completed_at
        ) values(
          ${secondCleanupId},'local-audio-object',${secondBlobKey},${secondBlobKey},
          ${handoverId},${secondCleanupJobId},2,'completed',1,'deleted',true,now()
        )
      `)
      let retry = await retryFailedHandoverJob(runtime.db, {
        id: retryJobId,
        handoverId,
      })
      assert.deepEqual(retry?.payload.audioCleanupDependencies, dependencies)
      assert.equal(retry?.payload.audioCleanupJobId, undefined)
      assert.equal(retry?.payload.retryFrom, 'analysis')
      assert.equal(retry?.kind, 'create')
      assert.equal(retry?.revision, 2)
    } finally {
      await runtime.db.exec(sql`
        delete from resource_cleanup_outbox where id in (${firstCleanupId},${secondCleanupId})
      `)
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.close()
    }
  })

  it('does not downgrade a local-first retry when the current preference is cloud', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let handoverId = randomUUID(), failedJobId = randomUUID(), retryJobId = randomUUID()
    try {
      await runtime.db.exec(sql`
        insert into handovers(
          id,title,source_department,context_type,consent_mode,priority_preference,
          transcript,processing_status,privacy_mode_floor,version,current_job_id,created_at,updated_at
        ) values(
          ${handoverId},'Privacy retry floor','Test ward','shift-handover','verbal','balanced',
          'Manual transcript','failed','local-first',1,${failedJobId},now(),now()
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(
          id,handover_id,revision,kind,status,attempts,payload,created_at,failed_at,updated_at,error_message
        ) values(
          ${failedJobId},${handoverId},1,'create','failed',1,
          '{"manualTranscript":"Manual transcript","privacyMode":"local-first","privacyPolicyVersion":1}'::jsonb,
          now(),now(),now(),'Analysis failed.'
        )
      `)

      let retry = await retryFailedHandoverJob(runtime.db, {
        id: retryJobId,
        handoverId,
        privacy: { privacyMode: 'cloud', privacyPolicyVersion: 1 },
      })
      assert.equal(retry?.payload.privacyMode, 'local-first')
      assert.equal(retry?.payload.privacyPolicyVersion, 1)
    } finally {
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.close()
    }
  })

  it('refuses local-first cleanup reconstruction without real, matching audio provenance', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    try {
      for (let testCase of [
        { name: 'mocked', mocked: true, includeBlob: true, mismatchedCleanupJob: false },
        { name: 'missing-blob', mocked: false, includeBlob: false, mismatchedCleanupJob: false },
        { name: 'mismatched-job', mocked: false, includeBlob: true, mismatchedCleanupJob: true },
      ]) {
        let handoverId = randomUUID(), failedJobId = randomUUID(), retryJobId = randomUUID()
        let blobKey = `audio/${randomUUID()}.webm`
        let cleanupJobId = testCase.mismatchedCleanupJob ? randomUUID() : failedJobId
        try {
          await runtime.db.exec(sql`
            insert into handovers(
              id,title,source_department,context_type,consent_mode,priority_preference,
              transcript,transcription_metadata,processing_status,version,created_at,updated_at
            ) values(
              ${handoverId},${`Unsafe cleanup ${testCase.name}`},'Test ward','shift-handover','verbal','balanced',
              'Persisted transcript',${JSON.stringify({ mocked: testCase.mocked })}::jsonb,'failed',1,now(),now()
            )
          `)
          await runtime.db.exec(sql`
            insert into handover_jobs(
              id,handover_id,revision,kind,status,attempts,payload,created_at,failed_at,updated_at,error_message
            ) values(
              ${failedJobId},${handoverId},1,'create','failed',1,
              ${JSON.stringify({
                ...(testCase.includeBlob ? { audioBlobKey: blobKey } : {}),
                audioCleanupJobId: cleanupJobId,
                retryFrom: 'analysis',
                privacyMode: 'cloud',
                privacyPolicyVersion: 1,
              })}::jsonb,now(),now(),now(),'Analysis failed.'
            )
          `)
          await runtime.db.exec(sql`update handovers set current_job_id=${failedJobId} where id=${handoverId}`)
          await runtime.db.exec(sql`
            insert into transcription_runs(
              id,handover_id,job_id,revision,provider,status,metadata,started_at,completed_at
            ) values(
              ${randomUUID()},${handoverId},${failedJobId},1,'assemblyai','completed',
              ${JSON.stringify({ mocked: testCase.mocked })}::jsonb,now(),now()
            )
          `)

          await assert.rejects(() => retryFailedHandoverJob(runtime.db, {
            id: retryJobId,
            handoverId,
            privacy: { privacyMode: 'local-first', privacyPolicyVersion: 1 },
          }), /safely prepare source recording deletion/)
          assert.equal((await runtime.db.exec(sql`
            select count(*)::int as count from handover_jobs where id=${retryJobId}
          `)).rows?.[0]?.count, 0)
          assert.equal((await runtime.db.exec(sql`
            select count(*)::int as count from resource_cleanup_outbox where job_id=${cleanupJobId}
          `)).rows?.[0]?.count, 0)
        } finally {
          await runtime.db.exec(sql`delete from resource_cleanup_outbox where job_id=${cleanupJobId}`)
          await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
        }
      }
    } finally {
      await runtime.close()
    }
  })

  it('rejects an analysis-only extension retry without a safe transcript segment count', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime(), handoverId = randomUUID(), failedJobId = randomUUID()
    try {
      await runtime.db.exec(sql`
        insert into handovers(
          id, title, source_department, context_type, consent_mode, priority_preference,
          transcript, transcription_metadata, processing_status, version, created_at, updated_at
        ) values(
          ${handoverId}, 'Extension retry invariant', 'Test ward', 'shift-handover', 'verbal', 'balanced',
          'Persisted transcript', '{"provider":"assemblyai"}'::jsonb, 'failed', 2, now(), now()
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(
          id, handover_id, revision, kind, status, attempts, payload, created_at, failed_at, updated_at
        ) values(
          ${failedJobId}, ${handoverId}, 2, 'extend', 'failed', 1,
          '{"retryFrom":"analysis"}'::jsonb, now(), now(), now()
        )
      `)
      await runtime.db.exec(sql`update handovers set current_job_id = ${failedJobId} where id = ${handoverId}`)

      await assert.rejects(() => retryFailedHandoverJob(runtime.db, {
        id: randomUUID(),
        handoverId,
      }), /safely retry/)
      assert.equal(await runtime.db.count(schema.handoverJobs, { where: { handover_id: handoverId } }), 1)
    } finally {
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.close()
    }
  })

  it('discards a failed extension without deleting the completed handover', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let userId = randomUUID(), handoverId = randomUUID(), completedJobId = randomUUID(), failedJobId = randomUUID()
    let audioKey = `audio/${randomUUID()}.webm`
    try {
      await runtime.db.exec(sql`
        insert into users(id,full_name,occupation,department,created_at,updated_at,last_active_at)
        values(${userId},'Discard Tester','Nurse','Test ward',now(),now(),now())
      `)
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,title,source_department,context_type,consent_mode,priority_preference,
          transcript,transcription_metadata,analysis,processing_status,version,current_job_id,created_at,updated_at
        ) values(
          ${handoverId},${userId},'Discard extension','Test ward','shift-handover','agreed','balanced',
          'Completed transcript',
          ${JSON.stringify({
            engine: 'assemblyai:universal-3-5-pro', mocked: false, language: 'en', durationMs: 1_000,
            interruptionSignals: [], noiseSignals: [], audioNoise: {},
            segments: [{ id: 'segment-1', startMs: 0, endMs: 1_000, text: 'Completed transcript', speaker: 'unknown', confidence: 0.9, flags: [] }],
          })}::jsonb,
          '{"headline":"Completed analysis"}'::jsonb,'failed',2,${failedJobId},now(),now()
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(id,handover_id,revision,kind,status,attempts,payload,created_at,completed_at,updated_at)
        values(${completedJobId},${handoverId},1,'create','completed',1,'{}'::jsonb,now(),now(),now())
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(id,handover_id,revision,kind,status,attempts,payload,created_at,failed_at,updated_at,error_message)
        values(${failedJobId},${handoverId},2,'extend','failed',1,
          ${JSON.stringify({ audioBlobKey: audioKey, manualTranscript: 'Failed clinical text' })}::jsonb,
          now(),now(),now(),'Transcription failed.')
      `)
      await runtime.db.exec(sql`
        insert into handover_audio(id,handover_id,revision,purpose,blob_key,content_type,original_filename,size_bytes,created_at)
        values(${randomUUID()},${handoverId},2,'extension',${audioKey},'audio/webm','failed.webm',100,now())
      `)

      let result = await discardFailedHandoverAttempt(runtime.db, { id: handoverId, userId })
      assert.deepEqual(result, { outcome: 'restored', discardedRevision: 2 })
      let restored = (await runtime.db.exec(sql`
        select transcript,analysis,processing_status,version,current_job_id,error_message
        from handovers where id=${handoverId}
      `)).rows?.[0]
      assert.equal(restored?.transcript, 'Completed transcript')
      assert.equal((restored?.analysis as Record<string, unknown>)?.headline, 'Completed analysis')
      assert.equal(restored?.processing_status, 'completed')
      assert.equal(restored?.version, 1)
      assert.equal(restored?.current_job_id, completedJobId)
      assert.equal(restored?.error_message, null)
      let discarded = (await runtime.db.exec(sql`select payload from handover_jobs where id=${failedJobId}`)).rows?.[0]?.payload as Record<string, unknown>
      assert.equal(typeof discarded.discardedAt, 'string')
      assert.equal(Object.keys(discarded).length, 1)
      assert.equal(await runtime.db.count(schema.handoverAudio, { where: { handover_id: handoverId } }), 0)
      let cleanupCount = (await runtime.db.exec(sql`
        select count(*)::int as count
        from resource_cleanup_outbox
        where handover_id=${handoverId}
      `)).rows?.[0]?.count
      assert.equal(Number(cleanupCount), 1)
    } finally {
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.db.exec(sql`delete from users where id=${userId}`)
      await runtime.close()
    }
  })

  it('discards a failed full privacy rerun by restoring its previous completed revision', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let userId = randomUUID(), handoverId = randomUUID()
    let completedJobId = randomUUID(), failedRerunJobId = randomUUID()
    try {
      await runtime.db.exec(sql`
        insert into users(id,full_name,occupation,department,created_at,updated_at,last_active_at)
        values(${userId},'Privacy Rerun Tester','Nurse','Test ward',now(),now(),now())
      `)
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,title,source_department,context_type,consent_mode,
          priority_preference,transcript,transcription_metadata,analysis,
          processing_status,privacy_mode_floor,version,current_job_id,created_at,updated_at
        ) values(
          ${handoverId},${userId},'Discard privacy rerun','Test ward','shift-handover','agreed',
          'balanced','Completed transcript',
          '{"engine":"manual-entry","mocked":false,"segments":[]}'::jsonb,
          '{"headline":"Completed analysis"}'::jsonb,
          'failed','local-first',2,${failedRerunJobId},now(),now()
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(
          id,handover_id,revision,kind,status,attempts,payload,
          created_at,completed_at,updated_at
        ) values(
          ${completedJobId},${handoverId},1,'create','completed',1,
          '{"manualTranscript":"Completed transcript"}'::jsonb,now(),now(),now()
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(
          id,handover_id,revision,kind,status,attempts,payload,
          created_at,failed_at,updated_at,error_message
        ) values(
          ${failedRerunJobId},${handoverId},2,'create','failed',1,
          ${JSON.stringify({
            retryFrom: 'analysis',
            manualTranscript: 'Completed transcript',
            privacyMode: 'local-first',
            privacyPolicyVersion: 1,
          })}::jsonb,now(),now(),now(),'Analysis failed.'
        )
      `)

      let result = await discardFailedHandoverAttempt(runtime.db, { id: handoverId, userId })
      assert.deepEqual(result, { outcome: 'restored', discardedRevision: 2 })
      let restored = (await runtime.db.exec(sql`
        select transcript,analysis,processing_status,version,current_job_id,error_message
        from handovers where id=${handoverId}
      `)).rows?.[0]
      assert.equal(restored?.transcript, 'Completed transcript')
      assert.equal((restored?.analysis as Record<string, unknown>)?.headline, 'Completed analysis')
      assert.equal(restored?.processing_status, 'completed')
      assert.equal(restored?.version, 1)
      assert.equal(restored?.current_job_id, completedJobId)
      assert.equal(restored?.error_message, null)
      let discarded = (await runtime.db.exec(sql`
        select payload from handover_jobs where id=${failedRerunJobId}
      `)).rows?.[0]?.payload as Record<string, unknown>
      assert.equal(typeof discarded.discardedAt, 'string')
      assert.equal(discarded.privacyMode, 'local-first')
      assert.equal(discarded.privacyPolicyVersion, 1)
      assert.equal(discarded.retryFrom, undefined)
      assert.equal(await runtime.db.count(schema.handovers, { where: { id: handoverId } }), 1)
    } finally {
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.db.exec(sql`delete from users where id=${userId}`)
      await runtime.close()
    }
  })

  it('removes an appended transcript tail when discarding a legacy failed analysis', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let userId = randomUUID(), handoverId = randomUUID(), completedJobId = randomUUID(), failedJobId = randomUUID()
    let metadata = {
      engine: 'manual-entry', mocked: false, language: 'en', durationMs: 2_000,
      interruptionSignals: [], noiseSignals: [], audioNoise: {},
      segments: [
        { id: 'segment-1', startMs: 0, endMs: 1_000, text: 'Completed transcript', speaker: 'unknown', confidence: 0.9, flags: [] },
        { id: 'segment-2', startMs: 1_000, endMs: 2_000, text: 'Failed extension', speaker: 'unknown', confidence: 0.9, flags: [] },
      ],
    }
    try {
      await runtime.db.exec(sql`
        insert into users(id,full_name,occupation,department,created_at,updated_at,last_active_at)
        values(${userId},'Legacy Discard Tester','Nurse','Test ward',now(),now(),now())
      `)
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,title,source_department,context_type,consent_mode,priority_preference,
          transcript,transcription_metadata,analysis,processing_status,version,current_job_id,created_at,updated_at
        ) values(
          ${handoverId},${userId},'Legacy discard','Test ward','shift-handover','agreed','balanced',
          'Completed transcript\nFailed extension',${JSON.stringify(metadata)}::jsonb,
          '{"headline":"Completed analysis"}'::jsonb,'failed',2,${failedJobId},now(),now()
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(id,handover_id,revision,kind,status,attempts,payload,created_at,completed_at,updated_at)
        values(${completedJobId},${handoverId},1,'create','completed',1,'{}'::jsonb,now(),now(),now())
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(id,handover_id,revision,kind,status,attempts,payload,created_at,failed_at,updated_at)
        values(${failedJobId},${handoverId},2,'extend','failed',1,
          '{"retryFrom":"analysis","retrySegmentCount":1,"privacyMode":"local-first","privacyPolicyVersion":1}'::jsonb,
          now(),now(),now())
      `)

      let result = await discardFailedHandoverAttempt(runtime.db, { id: handoverId, userId })
      assert.deepEqual(result, { outcome: 'restored', discardedRevision: 2 })
      let restored = (await runtime.db.exec(sql`
        select transcript,transcription_metadata,processing_status,version,privacy_mode_floor
        from handovers where id=${handoverId}
      `)).rows?.[0]
      assert.equal(restored?.transcript, 'Completed transcript')
      assert.equal((restored?.transcription_metadata as Record<string, unknown[]>).segments.length, 1)
      assert.equal(restored?.processing_status, 'completed')
      assert.equal(restored?.version, 1)
      assert.equal(restored?.privacy_mode_floor, 'local-first')
      let discarded = (await runtime.db.exec(sql`
        select payload from handover_jobs where id=${failedJobId}
      `)).rows?.[0]?.payload as Record<string, unknown>
      assert.equal(discarded.privacyMode, 'local-first')
      assert.equal(discarded.privacyPolicyVersion, 1)
      assert.equal(typeof discarded.discardedAt, 'string')
    } finally {
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.db.exec(sql`delete from users where id=${userId}`)
      await runtime.close()
    }
  })
})
