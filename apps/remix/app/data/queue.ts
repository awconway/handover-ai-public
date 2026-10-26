import { sql, type Database } from 'remix/data-table'
import { notifyHandoverJobQueued } from './handover-job-wakeup.ts'
import { notifyHandoverProcessingChanged } from './handover-processing-events.ts'
import { requireSuccessfulTranscriptionAudioCleanupInTransaction } from './audio-retention.ts'
import {
  currentPrivacyPolicyVersion,
  isLocalFirstAudioStorageBackendCompatible,
} from './local-first-processing.ts'
import { lockAudioBlobKeyForReferenceAssignment } from './resource-cleanup.ts'
import type { HandoverJobKind, HandoverJobPayload, HandoverJobRow } from './schema.ts'

const PRIVACY_FAMILY_ADVISORY_LOCK_SEED = 4_907_248_113_790_221

function positiveDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`)
  return value
}

export function parseHandoverJobPayload(value: unknown): HandoverJobPayload {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid handover job payload')
  let payload = value as Record<string, unknown>
  if (payload.privacyMode != null && payload.privacyMode !== 'cloud' && payload.privacyMode !== 'local-first') {
    throw new TypeError('Invalid privacyMode')
  }
  if (payload.privacyPolicyVersion != null && payload.privacyPolicyVersion !== 1) {
    throw new TypeError('Invalid privacyPolicyVersion')
  }
  if (
    payload.audioCleanupJobId != null
    && (typeof payload.audioCleanupJobId !== 'string' || !payload.audioCleanupJobId.trim())
  ) {
    throw new TypeError('Invalid audioCleanupJobId')
  }
  if (payload.audioCleanupDependencies != null && (
    !Array.isArray(payload.audioCleanupDependencies)
    || payload.audioCleanupDependencies.length < 1
    || payload.audioCleanupDependencies.length > 256
    || payload.audioCleanupDependencies.some((dependency) =>
      !dependency
      || typeof dependency !== 'object'
      || typeof dependency.jobId !== 'string'
      || !dependency.jobId.trim()
      || !Number.isSafeInteger(dependency.revision)
      || Number(dependency.revision) <= 0)
  )) {
    throw new TypeError('Invalid audioCleanupDependencies')
  }
  if (payload.retryFrom != null && payload.retryFrom !== 'analysis') throw new TypeError('Invalid retryFrom')
  if (payload.retrySegmentCount != null && (!Number.isSafeInteger(payload.retrySegmentCount) || Number(payload.retrySegmentCount) <= 0)) {
    throw new TypeError('Invalid retrySegmentCount')
  }
  if (payload.rollbackTranscript != null && typeof payload.rollbackTranscript !== 'string') {
    throw new TypeError('Invalid rollbackTranscript')
  }
  if (
    payload.rollbackTranscriptionMetadata != null
    && (typeof payload.rollbackTranscriptionMetadata !== 'object' || Array.isArray(payload.rollbackTranscriptionMetadata))
  ) {
    throw new TypeError('Invalid rollbackTranscriptionMetadata')
  }
  if (payload.discardedAt != null && typeof payload.discardedAt !== 'string') {
    throw new TypeError('Invalid discardedAt')
  }
  return payload as HandoverJobPayload
}

function parseJob(row: Record<string, unknown>): HandoverJobRow {
  let kind = row.kind
  let status = row.status
  if (kind !== 'create' && kind !== 'extend') throw new TypeError('Invalid handover job kind')
  if (!['queued', 'running', 'completed', 'failed'].includes(String(status))) throw new TypeError('Invalid handover job status')
  return {
    id: String(row.id), handover_id: String(row.handover_id), revision: Number(row.revision), kind,
    status: status as HandoverJobRow['status'], attempts: Number(row.attempts),
    locked_by: row.locked_by == null ? null : String(row.locked_by), locked_until: row.locked_until as Date | null,
    payload: parseHandoverJobPayload(row.payload), created_at: row.created_at as Date, started_at: row.started_at as Date | null,
    completed_at: row.completed_at as Date | null, failed_at: row.failed_at as Date | null,
    updated_at: row.updated_at as Date, error_message: row.error_message == null ? null : String(row.error_message),
  }
}

function changed(result: { rows?: Record<string, unknown>[] }): boolean {
  return (result.rows?.length ?? 0) === 1
}

/** Acquire before locking or inserting any member of a handover privacy family. */
export async function lockHandoverPrivacyFamilyForTransaction(
  db: Database,
  handoverId: string,
): Promise<string | null> {
  let family = await db.exec(sql`
    select coalesce(source_handover_id, id) as family_root_id
    from handovers where id = ${handoverId}
  `)
  let familyRootId = family.rows?.[0]?.family_root_id
  if (typeof familyRootId !== 'string' || !familyRootId) return null
  let lockKey = JSON.stringify(['handover-privacy-family', familyRootId])
  await db.exec(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${lockKey}, ${PRIVACY_FAMILY_ADVISORY_LOCK_SEED}::bigint)
    )
  `)
  return familyRootId
}

async function ratchetLockedHandoverPrivacyFamily(db: Database, input: {
  familyRootId: string
  runningJobId?: string
  workerId?: string
}): Promise<HandoverJobPayload | null> {
  let hasRunningJob = input.runningJobId != null || input.workerId != null
  let runningJobClause = hasRunningJob
    ? sql`or (
        job.id = ${input.runningJobId!}
        and job.status = 'running'
        and job.locked_by = ${input.workerId!}
      )`
    : sql``
  // Cross-subsystem order: privacy-family advisory lock -> handover rows ->
  // job rows -> cleanup outbox rows -> cleanup-resource advisory lock. A
  // transaction may take a suffix, but must not acquire an earlier class later.
  await db.exec(sql`
    update handovers handover set
      privacy_mode_floor = 'local-first', updated_at = now()
    where handover.id = ${input.familyRootId}
      or handover.source_handover_id = ${input.familyRootId}
  `)
  let jobs = await db.exec(sql`
    select job.id, job.revision, job.status, job.payload
    from handover_jobs job
    join handovers handover on handover.id = job.handover_id
    where (handover.id = ${input.familyRootId} or handover.source_handover_id = ${input.familyRootId})
      and (job.status = 'queued' ${runningJobClause})
    order by job.handover_id, job.revision, job.created_at, job.id
    for update of job
  `)

  let runningPayload: HandoverJobPayload | null = null
  for (let row of jobs.rows ?? []) {
    let payload: HandoverJobPayload = {
      ...parseHandoverJobPayload(row.payload),
      privacyMode: 'local-first',
      privacyPolicyVersion: currentPrivacyPolicyVersion,
    }
    let manualTranscript = typeof payload.manualTranscript === 'string'
      ? payload.manualTranscript.trim()
      : ''
    if (payload.retryFrom === 'analysis' && !manualTranscript) {
      let dependencies = payload.audioCleanupDependencies ?? [{
        jobId: typeof payload.audioCleanupJobId === 'string'
          ? payload.audioCleanupJobId.trim()
          : String(row.id),
        revision: Number(row.revision),
      }]
      for (let dependency of dependencies) {
        let requiredCleanup = await requireSuccessfulTranscriptionAudioCleanupInTransaction(db, {
          cleanupJobId: dependency.jobId,
          revision: dependency.revision,
        })
        if (!requiredCleanup) {
          throw new Error('Could not safely prepare source recording deletion while enabling local-first processing.')
        }
      }
      if (!payload.audioCleanupDependencies) payload.audioCleanupJobId = dependencies[0]!.jobId
      delete payload.audioBlobKey
      delete payload.audioOriginalFilename
    }
    let updated = await db.exec(sql`
      update handover_jobs job set payload = ${JSON.stringify(payload)}::jsonb, updated_at = now()
      where job.id = ${String(row.id)}
        and (status = 'queued' ${runningJobClause})
      returning id
    `)
    if (!updated.rows?.[0]) {
      throw new Error('Handover job changed while local-first processing was enabled.')
    }
    if (hasRunningJob && row.id === input.runningJobId) runningPayload = payload
  }
  return runningPayload
}

/**
 * Tighten an authoritative handover and every extant recipient copy as one
 * privacy family. Recipient copies deliberately retain source_handover_id
 * after the source is deleted, so the same root key also protects orphans.
 */
export async function ratchetHandoverPrivacyFamily(db: Database, input: {
  handoverId: string
  runningJobId?: string
  workerId?: string
}): Promise<HandoverJobPayload | null> {
  let hasRunningJob = input.runningJobId != null || input.workerId != null
  if (hasRunningJob && (!input.runningJobId || !input.workerId)) {
    throw new TypeError('runningJobId and workerId must be supplied together')
  }
  return db.transaction(async (tx) => {
    let familyRootId = await lockHandoverPrivacyFamilyForTransaction(tx, input.handoverId)
    if (!familyRootId) return null
    return ratchetLockedHandoverPrivacyFamily(tx, {
      familyRootId,
      runningJobId: input.runningJobId,
      workerId: input.workerId,
    })
  })
}

async function enqueueLockedHandoverJob(
  tx: Database,
  input: { id: string; handoverId: string; revision: number; kind: HandoverJobKind },
  requestedPayload: HandoverJobPayload,
  familyRootId: string,
): Promise<HandoverJobRow> {
  let handover = await tx.exec(sql`
    select id, privacy_mode_floor, coalesce(source_handover_id, id) as family_root_id
    from handovers where id = ${input.handoverId} for update
  `)
  let locked = handover.rows?.[0]
  if (!locked) throw new Error('Handover not found.')
  if (locked.family_root_id !== familyRootId) {
    throw new Error('Handover privacy family changed while the job was queued.')
  }
  if (locked.privacy_mode_floor !== 'cloud' && locked.privacy_mode_floor !== 'local-first') {
    throw new TypeError('Invalid handover privacy mode floor')
  }
  let localFirstRequired = locked.privacy_mode_floor === 'local-first'
    || requestedPayload.privacyMode === 'local-first'
  let payload: HandoverJobPayload = localFirstRequired
    ? {
        ...requestedPayload,
        privacyMode: 'local-first',
        privacyPolicyVersion: currentPrivacyPolicyVersion,
      }
    : requestedPayload
  if (localFirstRequired) {
    await ratchetLockedHandoverPrivacyFamily(tx, { familyRootId })
  }
  let audioBlobKey = typeof payload.audioBlobKey === 'string' ? payload.audioBlobKey.trim() : ''
  if (audioBlobKey) await lockAudioBlobKeyForReferenceAssignment(tx, audioBlobKey)
  let result = await tx.exec(sql`
    insert into handover_jobs (id, handover_id, revision, kind, status, attempts, payload, created_at, updated_at)
    values (${input.id}, ${input.handoverId}, ${input.revision}, ${input.kind}, 'queued', 0, ${JSON.stringify(payload)}::jsonb, now(), now())
    returning *
  `)
  await tx.exec(sql`
    with queue_head as (
      select id, revision, created_at from handover_jobs
      where handover_id = ${input.handoverId} and status = 'queued'
      order by revision asc, created_at asc limit 1
    )
    update handovers set
      current_job_id = case
        when exists (select 1 from handover_jobs active where active.id = handovers.current_job_id and active.status in ('queued','running')) then current_job_id
        else (select id from queue_head)
      end,
      version = case
        when exists (select 1 from handover_jobs active where active.id = handovers.current_job_id and active.status in ('queued','running')) then version
        else (select revision from queue_head)
      end,
      processing_status = case
        when exists (select 1 from handover_jobs active where active.id = handovers.current_job_id and active.status in ('queued','running')) then processing_status
        else 'queued'
      end,
      processing_started_at = case
        when exists (select 1 from handover_jobs active where active.id = handovers.current_job_id and active.status in ('queued','running')) then processing_started_at
        else (select created_at from queue_head)
      end,
      processing_lease_until = case
        when exists (select 1 from handover_jobs active where active.id = handovers.current_job_id and active.status in ('running')) then processing_lease_until
        else null
      end,
      error_message = null,
      updated_at = now()
    where id = ${input.handoverId}
  `)
  await notifyHandoverJobQueued(tx, input.id)
  await notifyHandoverProcessingChanged(tx, input.handoverId)
  return parseJob(result.rows![0])
}

export async function enqueueHandoverJob(db: Database, input: {
  id: string; handoverId: string; revision: number; kind: HandoverJobKind; payload?: HandoverJobPayload
}): Promise<HandoverJobRow> {
  if (!Number.isSafeInteger(input.revision) || input.revision <= 0) throw new RangeError('revision must be positive')
  let requestedPayload = parseHandoverJobPayload(input.payload ?? {})
  return db.transaction(async (tx) => {
    let familyRootId = await lockHandoverPrivacyFamilyForTransaction(tx, input.handoverId)
    if (!familyRootId) throw new Error('Handover not found.')
    return enqueueLockedHandoverJob(tx, input, requestedPayload, familyRootId)
  })
}

/**
 * Claims one eligible job and its handover row under one Postgres lock scope.
 * SKIP LOCKED is deliberately expressed through data-table's supported raw SQL
 * escape hatch because it is a database concurrency primitive, not generic CRUD.
 */
export async function claimNextHandoverJob(db: Database, input: { workerId: string; lockMs: number }): Promise<HandoverJobRow | null> {
  let lockMs = positiveDuration(input.lockMs, 'lockMs')
  return db.transaction(async (tx) => {
    let result = await tx.exec(sql`
      update handover_jobs set
        status = 'running', attempts = attempts + 1, locked_by = ${input.workerId},
        locked_until = now() + (${lockMs}::text || ' milliseconds')::interval,
        payload = case
          when exists (
            select 1 from handovers privacy_handover
            where privacy_handover.id = handover_jobs.handover_id
              and privacy_handover.privacy_mode_floor = 'local-first'
          ) then jsonb_set(payload, '{privacyMode}', '"local-first"'::jsonb, true)
          else payload
        end,
        started_at = coalesce(started_at, now()), updated_at = now(), error_message = null
      where id = (
        select candidate_jobs.id
        from handover_jobs candidate_jobs
        join handovers candidate_handovers on candidate_handovers.id = candidate_jobs.handover_id
        where (
          candidate_jobs.status = 'queued'
          or (candidate_jobs.status = 'running' and candidate_jobs.locked_until is not null and candidate_jobs.locked_until < now())
        )
        and (
          candidate_handovers.current_job_id is null or candidate_handovers.current_job_id = candidate_jobs.id
          or exists (select 1 from handover_jobs active where active.id = candidate_handovers.current_job_id and active.status in ('completed','failed'))
        )
        and not exists (
          select 1 from handover_jobs earlier
          where earlier.handover_id = candidate_jobs.handover_id and earlier.status in ('queued','running')
            and (earlier.revision < candidate_jobs.revision or (earlier.revision = candidate_jobs.revision and earlier.created_at < candidate_jobs.created_at))
        )
        order by candidate_jobs.created_at asc
        for update of candidate_jobs, candidate_handovers skip locked
        limit 1
      ) returning *
    `)
    return result.rows?.[0] ? parseJob(result.rows[0]) : null
  })
}

export async function acquireHandoverJobLease(db: Database, input: { handoverId: string; jobId: string; lockMs: number }): Promise<boolean> {
  let result = await db.exec(sql`
    update handovers set current_job_id = ${input.jobId}, version = active_job.revision,
      processing_status = 'queued', processing_started_at = active_job.created_at, error_message = null,
      processing_lease_until = now() + (${positiveDuration(input.lockMs, 'lockMs')}::text || ' milliseconds')::interval,
      updated_at = now()
    from handover_jobs active_job
    where handovers.id = ${input.handoverId} and active_job.id = ${input.jobId}
      and active_job.handover_id = handovers.id and active_job.status = 'running' and (
      current_job_id is null or current_job_id = ${input.jobId}
      or exists (select 1 from handover_jobs active where active.id = handovers.current_job_id and active.status in ('completed','failed'))
    ) returning handovers.id
  `)
  return changed(result)
}

export async function refreshHandoverJobLease(db: Database, input: { handoverId: string; jobId: string; workerId: string; lockMs: number }): Promise<boolean> {
  let lockMs = positiveDuration(input.lockMs, 'lockMs')
  let result = await db.exec(sql`
    with renewed_job as (
      update handover_jobs set locked_until = now() + (${lockMs}::text || ' milliseconds')::interval, updated_at = now()
      where id = ${input.jobId} and handover_id = ${input.handoverId} and status = 'running' and locked_by = ${input.workerId}
        and exists (select 1 from handovers where id = ${input.handoverId} and current_job_id = ${input.jobId})
      returning id
    )
    update handovers set processing_lease_until = now() + (${lockMs}::text || ' milliseconds')::interval, updated_at = now()
    where id = ${input.handoverId} and current_job_id = ${input.jobId} and exists (select 1 from renewed_job)
    returning id
  `)
  return changed(result)
}

export async function completeHandoverJob(db: Database, input: { jobId: string; workerId: string }): Promise<boolean> {
  let result = await db.exec(sql`
    with completed_job as (
      update handover_jobs set status = 'completed', locked_by = null, locked_until = null,
        completed_at = now(), updated_at = now(), error_message = null,
        payload = payload - 'rollbackTranscript' - 'rollbackTranscriptionMetadata'
      where id = ${input.jobId} and status = 'running' and locked_by = ${input.workerId}
      returning id, handover_id
    ), next_job as (
      select queued.id, queued.revision, queued.created_at
      from handover_jobs queued
      join completed_job on completed_job.handover_id = queued.handover_id
      where queued.status = 'queued'
      order by queued.revision asc, queued.created_at asc
      limit 1
    )
    update handovers set
      current_job_id = coalesce((select id from next_job), (select id from completed_job)),
      version = coalesce((select revision from next_job), version),
      processing_status = case when exists (select 1 from next_job) then 'queued' else 'completed' end,
      processing_started_at = case when exists (select 1 from next_job) then (select created_at from next_job) else null end,
      processing_lease_until = null, error_message = null, updated_at = now()
    where id = (select handover_id from completed_job) and current_job_id = (select id from completed_job)
      and exists (select 1 from completed_job) returning id
  `)
  let completed = changed(result)
  if (completed) await notifyHandoverProcessingChanged(db, String(result.rows![0]!.id))
  return completed
}

export async function failHandoverJob(db: Database, input: { handoverId: string; jobId: string; workerId: string; errorMessage: string }): Promise<boolean> {
  return db.transaction(async (tx) => {
    let result = await tx.exec(sql`
      with failed_job as (
        update handover_jobs set status = 'failed', locked_by = null, locked_until = null,
          failed_at = now(), updated_at = now(), error_message = ${input.errorMessage}
        where id = ${input.jobId} and handover_id = ${input.handoverId} and status = 'running' and locked_by = ${input.workerId}
        returning id
      )
      update handovers set processing_status = 'failed', processing_started_at = null,
        processing_lease_until = null, error_message = ${input.errorMessage}, updated_at = now()
      where id = ${input.handoverId} and current_job_id = ${input.jobId} and exists (select 1 from failed_job)
      returning id
    `)
    let failed = changed(result)
    if (failed) await notifyHandoverProcessingChanged(tx, input.handoverId)
    return failed
  })
}

export async function clearHandoverJobLease(db: Database, input: { handoverId: string; jobId: string }): Promise<void> {
  await db.exec(sql`
    with next_job as (
      select id, revision, created_at from handover_jobs where handover_id = ${input.handoverId} and status = 'queued'
      order by revision asc, created_at asc limit 1
    )
    update handovers set current_job_id = (select id from next_job), processing_lease_until = null,
      version = coalesce((select revision from next_job), version),
      processing_status = case when exists (select 1 from next_job) then 'queued' else processing_status end,
      processing_started_at = case when exists (select 1 from next_job) then (select created_at from next_job) else processing_started_at end,
      updated_at = now()
    where id = ${input.handoverId} and current_job_id = ${input.jobId}
  `)
}

/**
 * Retries a failed revision with a fresh durable job. The failed row remains
 * immutable audit history; a completed transcription may be reused only when
 * its run metadata proves that analysis can restart safely.
 */
export async function retryFailedHandoverJob(db: Database, input: {
  id: string
  handoverId: string
  privacy?: Pick<HandoverJobPayload, 'privacyMode' | 'privacyPolicyVersion'>
  localFirstAudioStorageCompatible?: boolean
}): Promise<HandoverJobRow | null> {
  let currentPrivacy = parseHandoverJobPayload(input.privacy ?? {})
  let localFirstAudioStorageCompatible = input.localFirstAudioStorageCompatible
    ?? isLocalFirstAudioStorageBackendCompatible()
  return db.transaction(async (tx) => {
    let familyRootId = await lockHandoverPrivacyFamilyForTransaction(tx, input.handoverId)
    if (!familyRootId) return null
    let handoverResult = await tx.exec(sql`
      select id, version, transcript, transcription_metadata, processing_status,
        privacy_mode_floor, coalesce(source_handover_id, id) as family_root_id
      from handovers where id = ${input.handoverId} for update
    `)
    let handover = handoverResult.rows?.[0]
    if (!handover || handover.processing_status !== 'failed') return null
    if (handover.family_root_id !== familyRootId) {
      throw new Error('Handover privacy family changed while the retry was queued.')
    }
    if (handover.privacy_mode_floor !== 'cloud' && handover.privacy_mode_floor !== 'local-first') {
      throw new TypeError('Invalid handover privacy mode floor')
    }

    let failedResult = await tx.exec(sql`
      select * from handover_jobs
      where handover_id = ${input.handoverId} and status = 'failed'
      order by (revision = ${Number(handover.version)}) desc, updated_at desc, created_at desc
      limit 1
    `)
    let failedRow = failedResult.rows?.[0]
    if (!failedRow) return null
    let failed = parseJob(failedRow)
    let payload: HandoverJobPayload = { ...failed.payload }
    let localFirstRequired = handover.privacy_mode_floor === 'local-first'
      || payload.privacyMode === 'local-first'
      || currentPrivacy.privacyMode === 'local-first'
    if (localFirstRequired) {
      payload.privacyMode = 'local-first'
      payload.privacyPolicyVersion = currentPrivacyPolicyVersion
    } else if (currentPrivacy.privacyMode) {
      payload.privacyMode = currentPrivacy.privacyMode
      payload.privacyPolicyVersion = currentPrivacy.privacyPolicyVersion ?? currentPrivacyPolicyVersion
    }

    if (payload.retryFrom === 'analysis') {
      if (failed.kind === 'create') {
        delete payload.retrySegmentCount
      } else if (!payload.retrySegmentCount) {
        throw new Error('Could not safely retry the recommenced handover transcript.')
      }
    } else {
      let completedRun = await tx.exec(sql`
        select metadata from transcription_runs
        where job_id = ${failed.id} and status = 'completed'
        order by completed_at desc nulls last, started_at desc
        limit 1
      `)
      let hasPersistedTranscription = typeof handover.transcript === 'string'
        && handover.transcript.trim().length > 0
        && handover.transcription_metadata != null
      if (completedRun.rows?.[0] && hasPersistedTranscription) {
        payload.retryFrom = 'analysis'
        if (failed.kind === 'extend') {
          let metadata = completedRun.rows[0].metadata
          let segmentCount = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? Number((metadata as Record<string, unknown>).segmentCount)
            : Number.NaN
          if (!Number.isSafeInteger(segmentCount) || segmentCount <= 0) {
            throw new Error('Could not safely retry the recommenced handover transcript.')
          }
          payload.retrySegmentCount = segmentCount
        } else {
          delete payload.retrySegmentCount
        }
      } else {
        delete payload.retryFrom
        delete payload.retrySegmentCount
      }
    }

    if (
      localFirstRequired
      && payload.retryFrom !== 'analysis'
      && !(typeof payload.manualTranscript === 'string' && payload.manualTranscript.trim())
      && !localFirstAudioStorageCompatible
    ) {
      throw new Error('Local-first audio requires workstation-local filesystem storage.')
    }

    if (
      localFirstRequired
      && payload.retryFrom === 'analysis'
      && !(typeof payload.manualTranscript === 'string' && payload.manualTranscript.trim())
    ) {
      let cleanupDependencies = payload.audioCleanupDependencies ?? [{
        jobId: typeof payload.audioCleanupJobId === 'string' && payload.audioCleanupJobId.trim()
          ? payload.audioCleanupJobId.trim()
          : failed.id,
        revision: failed.revision,
      }]
      for (let dependency of cleanupDependencies) {
        let requiredCleanup = await requireSuccessfulTranscriptionAudioCleanupInTransaction(tx, {
          cleanupJobId: dependency.jobId,
          revision: dependency.revision,
        })
        if (!requiredCleanup) {
          throw new Error('Could not safely prepare source recording deletion for local-first retry.')
        }
      }
      if (!payload.audioCleanupDependencies) {
        payload.audioCleanupJobId = cleanupDependencies[0]!.jobId
      }
      // The durable cleanup identity, not a fresh raw-object reference, gates
      // this analysis-only retry. Keeping audioBlobKey here would conflict with
      // the cleanup outbox and could make an otherwise safe retry unqueueable.
      delete payload.audioBlobKey
      delete payload.audioOriginalFilename
    }

    return enqueueLockedHandoverJob(tx, {
      id: input.id,
      handoverId: input.handoverId,
      revision: failed.revision,
      kind: failed.kind,
    }, payload, familyRootId)
  })
}

export async function releaseWorkerLeases(db: Database, workerId: string): Promise<number> {
  let result = await db.exec(sql`
    update handover_jobs set locked_until = now() - interval '1 millisecond', updated_at = now()
    where status = 'running' and locked_by = ${workerId}
  `)
  return result.affectedRows ?? 0
}
