import { randomUUID } from 'node:crypto'

import { sql, type Database } from 'remix/data-table'

import {
  claimNextResourceCleanup,
  claimResourceCleanupById,
  completeClaimedResourceCleanupInTransaction,
  deferClaimedResourceCleanup,
  enqueueResourceCleanupIfEligibleInTransaction,
  enqueueResourceCleanupInTransaction,
  EXPLICIT_AUDIO_DELETION_JOB_PREFIX,
  failClaimedResourceCleanup,
  getResourceCleanupById,
  getResourceCleanupForIdentity,
  getRequiredResourceCleanupForJob,
  LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
  lockCleanupResourceForTransaction,
  PROVISIONAL_AUDIO_UPLOAD_JOB_PREFIX,
  requireExistingResourceCleanupForJobInTransaction,
  type ResourceCleanupItem,
} from './resource-cleanup.ts'
import type { UploadStorage } from './upload-storage.ts'

type Environment = Readonly<Record<string, string | undefined>>

export type SuccessfulTranscriptionAudioRetentionInput = {
  handoverId: string
  jobId: string
  revision: number
  /** The exact object consumed by this transcription attempt. */
  processedAudioBlobKey: string | null | undefined
  /**
   * Require deletion for this job even when the environment normally retains
   * successful-transcription audio. This overrides retention policy only;
   * eligibility checks and shared/active-reference deferral still apply.
   */
  deletionRequired?: boolean
}

type DeferredReason = 'active-transcription-reference' | 'shared-audio-reference'

export type SuccessfulTranscriptionAudioRetentionResult =
  | { status: 'retained-by-policy' | 'no-processed-audio' | 'no-work' }
  | { status: 'not-eligible'; reason: 'job-mismatch' | 'transcript-not-persisted' | 'mock-transcription' }
  | { status: 'scheduled'; cleanupId: string }
  | { status: 'deferred'; reason: DeferredReason; cleanupId: string }
  | { status: 'deleted' | 'already-missing'; referencesCleared: true; cleanupId: string }
  | { status: 'delete-failed'; referencesCleared: false; cleanupId: string }

export type ConfirmedSuccessfulTranscriptionAudioDeletion = Extract<
  SuccessfulTranscriptionAudioRetentionResult,
  { status: 'deleted' | 'already-missing' }
>

/** Narrow the cleanup result before allowing privacy-sensitive processing to continue. */
export function isSuccessfulTranscriptionAudioDeletionConfirmed(
  result: SuccessfulTranscriptionAudioRetentionResult,
): result is ConfirmedSuccessfulTranscriptionAudioDeletion {
  return result.status === 'deleted' || result.status === 'already-missing'
}

export type SuccessfulTranscriptionAudioRetention = {
  release(input: SuccessfulTranscriptionAudioRetentionInput): Promise<SuccessfulTranscriptionAudioRetentionResult>
  /** Prove and, when claimable, complete the original required cleanup. */
  confirmRequiredDeletion(input: { jobId: string; revision: number }): Promise<SuccessfulTranscriptionAudioRetentionResult>
  /** Best-effort drain hook for startup/idle-loop retries. */
  processNext(): Promise<SuccessfulTranscriptionAudioRetentionResult>
}

type RetentionOptions = {
  db: Database
  storage: Pick<UploadStorage, 'delete'>
  env?: Environment
  workerId?: string
  lockMs?: number
  retryBaseMs?: number
}

export function retainUploadedAudioAfterTranscription(env: Environment = process.env): boolean {
  let configured = env.RETAIN_UPLOADED_AUDIO_AFTER_TRANSCRIPTION
  if (configured == null) return env.NODE_ENV !== 'production'
  return configured.trim().toLowerCase() === 'true'
}

/**
 * Persists cleanup intent in the caller's transcription-completion transaction.
 * This function never contacts object storage; the post-commit release/drain
 * path owns that external side effect.
 */
export async function scheduleSuccessfulTranscriptionAudioCleanupInTransaction(
  db: Database,
  request: SuccessfulTranscriptionAudioRetentionInput & { transcriptionMocked: boolean },
  env: Environment = process.env,
): Promise<SuccessfulTranscriptionAudioRetentionResult> {
  if (!request.deletionRequired && retainUploadedAudioAfterTranscription(env)) {
    return { status: 'retained-by-policy' }
  }
  let blobKey = nonEmpty(request.processedAudioBlobKey)
  if (!blobKey) return { status: 'no-processed-audio' }
  positiveInteger(request.revision, 'revision')
  if (request.transcriptionMocked) return { status: 'not-eligible', reason: 'mock-transcription' }
  let item = await enqueueResourceCleanupInTransaction(db, {
    kind: LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
    resourceId: blobKey,
    blobKey,
    handoverId: request.handoverId,
    jobId: request.jobId,
    revision: request.revision,
    deletionRequired: request.deletionRequired,
  })
  return { status: 'scheduled', cleanupId: item.id }
}

/**
 * Make the original transcription's cleanup a mandatory dependency before an
 * analysis-only retry is upgraded to local-first. Existing cleanup intent is
 * promoted in place. When ordinary retention created no row, reconstruction is
 * permitted only from the exact completed real-transcription provenance.
 */
export async function requireSuccessfulTranscriptionAudioCleanupInTransaction(
  db: Database,
  request: { cleanupJobId: string; revision: number },
): Promise<ResourceCleanupItem | null> {
  let cleanupJobId = nonEmpty(request.cleanupJobId)
  if (!cleanupJobId) throw new TypeError('cleanupJobId is required')
  positiveInteger(request.revision, 'revision')

  let existing = await requireExistingResourceCleanupForJobInTransaction(db, {
    kind: LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
    jobId: cleanupJobId,
    revision: request.revision,
  })
  if (existing) return existing

  let evidence = await db.exec(sql`
    select
      j.handover_id,
      nullif(btrim(j.payload ->> 'audioBlobKey'), '') as audio_blob_key,
      h.transcript is not null and btrim(h.transcript) <> '' as transcript_persisted,
      h.transcription_metadata is not null as metadata_persisted,
      h.transcription_metadata ->> 'mocked' as metadata_mocked,
      exists (
        select 1 from transcription_runs completed_run
        where completed_run.job_id = j.id
          and completed_run.handover_id = j.handover_id
          and completed_run.revision = j.revision
          and completed_run.status = 'completed'
      ) as run_confirmed
    from handover_jobs j
    join handovers h on h.id = j.handover_id
    where j.id = ${cleanupJobId}
      and j.revision = ${request.revision}
      and j.status in ('failed', 'completed', 'running')
    for update of j, h
  `)
  let row = evidence.rows?.[0]
  let blobKey = nonEmpty(typeof row?.audio_blob_key === 'string' ? row.audio_blob_key : null)
  if (
    !row
    || !blobKey
    || !isTrue(row.transcript_persisted)
    || !isTrue(row.metadata_persisted)
    || !isFalse(row.metadata_mocked)
    || !isTrue(row.run_confirmed)
  ) {
    return null
  }

  return enqueueResourceCleanupInTransaction(db, {
    kind: LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
    resourceId: blobKey,
    blobKey,
    handoverId: String(row.handover_id),
    jobId: cleanupJobId,
    revision: request.revision,
    deletionRequired: true,
  })
}

function nonEmpty(value: string | null | undefined): string | null {
  let normalized = value?.trim() ?? ''
  return normalized || null
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`)
  return value
}

function isTrue(value: unknown): boolean {
  return value === true || value === 'true'
}

function isFalse(value: unknown): boolean {
  return value === false || value === 'false'
}

function retryDelay(attempts: number, baseMs: number): number {
  return Math.min(60 * 60 * 1_000, baseMs * (2 ** Math.min(Math.max(0, attempts - 1), 7)))
}

async function findForeignReferences(db: Database, item: ResourceCleanupItem): Promise<{
  activeTranscription: boolean
  sharedAudio: boolean
}> {
  // A retry creates a new job and moves current_job_id. Superseded failed
  // attempts are history; only the owning handover's current failure remains
  // retryable. Queued and running references must always retain their audio.
  let result = await db.exec(sql`
    select
      exists(
        select 1 from handover_jobs referenced_job
        where referenced_job.id <> ${item.jobId}
          and (
            referenced_job.status in ('queued', 'running')
            or (
              referenced_job.status = 'failed'
              and exists (
                select 1 from handovers owning_handover
                where owning_handover.id = referenced_job.handover_id
                  and owning_handover.current_job_id = referenced_job.id
              )
            )
          )
          and nullif(btrim(referenced_job.payload ->> 'audioBlobKey'), '') = ${item.blobKey}
          and coalesce(referenced_job.payload ->> 'retryFrom', '') <> 'analysis'
      ) as active_transcription,
      (
        exists(
          select 1 from handovers referenced_handover
          where referenced_handover.audio_blob_key = ${item.blobKey}
            and referenced_handover.id <> ${item.handoverId}
            and not exists(
              select 1 from resource_cleanup_outbox coordinated_cleanup
              where coordinated_cleanup.kind = ${LOCAL_AUDIO_OBJECT_CLEANUP_KIND}
                and coordinated_cleanup.resource_id = ${item.resourceId}
                and coordinated_cleanup.blob_key = ${item.blobKey}
                and coordinated_cleanup.handover_id = referenced_handover.id
            )
        )
        or exists(
          select 1 from handover_audio referenced_audio
          where referenced_audio.blob_key = ${item.blobKey}
            and (referenced_audio.handover_id <> ${item.handoverId} or referenced_audio.revision <> ${item.revision})
            and not exists(
              select 1 from resource_cleanup_outbox coordinated_cleanup
              where coordinated_cleanup.kind = ${LOCAL_AUDIO_OBJECT_CLEANUP_KIND}
                and coordinated_cleanup.resource_id = ${item.resourceId}
                and coordinated_cleanup.blob_key = referenced_audio.blob_key
                and coordinated_cleanup.handover_id = referenced_audio.handover_id
                and coordinated_cleanup.revision = referenced_audio.revision
            )
        )
      ) as shared_audio
  `)
  let row = result.rows?.[0]
  return {
    activeTranscription: isTrue(row?.active_transcription),
    sharedAudio: isTrue(row?.shared_audio),
  }
}

async function prepareClaim(
  db: Database,
  item: ResourceCleanupItem,
  workerId: string,
  retryBaseMs: number,
): Promise<DeferredReason | null | 'lost-claim'> {
  return db.transaction(async (tx) => {
    let claimed = await tx.exec(sql`
      select * from resource_cleanup_outbox
      where id = ${item.id} and kind = ${LOCAL_AUDIO_OBJECT_CLEANUP_KIND}
        and status = 'running' and locked_by = ${workerId} and locked_until > now()
      for update
    `)
    if (!claimed.rows?.[0]) return 'lost-claim'
    await lockCleanupResourceForTransaction(tx, item.kind, item.resourceId)
    let references = await findForeignReferences(tx, item)
    let reason: DeferredReason | null = references.activeTranscription
      ? 'active-transcription-reference'
      : references.sharedAudio ? 'shared-audio-reference' : null
    if (reason) {
      await deferClaimedResourceCleanup(tx, {
        id: item.id,
        workerId,
        reason,
        retryMs: retryDelay(item.attempts, retryBaseMs),
      })
    }
    return reason
  })
}

async function finalizeDeletedAudio(
  db: Database,
  item: ResourceCleanupItem,
  workerId: string,
  deleted: boolean,
  retryBaseMs: number,
): Promise<SuccessfulTranscriptionAudioRetentionResult> {
  return db.transaction(async (tx) => {
    // Match the cross-subsystem order used by privacy-family ratchets:
    // handover -> job -> cleanup outbox -> cleanup-resource advisory lock.
    // The durable running row prevents new reference assignment while these
    // authoritative rows are acquired after the external delete.
    await tx.exec(sql`select id from handovers where id = ${item.handoverId} for update`)
    await tx.exec(sql`
      select id from handover_jobs
      where id = ${item.jobId} and handover_id = ${item.handoverId}
      for update
    `)
    let claimed = await tx.exec(sql`
      select * from resource_cleanup_outbox
      where id = ${item.id} and kind = ${LOCAL_AUDIO_OBJECT_CLEANUP_KIND}
        and status = 'running' and locked_by = ${workerId}
      for update
    `)
    if (!claimed.rows?.[0]) return { status: 'scheduled', cleanupId: item.id } as const
    await lockCleanupResourceForTransaction(tx, item.kind, item.resourceId)

    // Recheck after external deletion. Correct writers cannot create a phantom
    // reference because their assignment helper observes this running outbox.
    let references = await findForeignReferences(tx, item)
    if (references.activeTranscription || references.sharedAudio) {
      await failClaimedResourceCleanup(tx, {
        id: item.id,
        workerId,
        errorMessage: 'A new audio reference appeared while cleanup was running.',
        retryMs: retryDelay(item.attempts, retryBaseMs),
      })
      return { status: 'delete-failed', referencesCleared: false, cleanupId: item.id } as const
    }

    // Clear only the exact handover/job/revision references recorded by the
    // outbox. A newer extension with another key is untouched.
    await tx.exec(sql`
      update handovers set
        audio_blob_key = null,
        audio_content_type = null,
        audio_original_filename = null,
        audio_size_bytes = null,
        updated_at = now()
      where id = ${item.handoverId} and audio_blob_key = ${item.blobKey}
    `)
    await tx.exec(sql`
      delete from handover_audio
      where handover_id = ${item.handoverId} and revision = ${item.revision}
        and blob_key = ${item.blobKey}
    `)
    await tx.exec(sql`
      update handover_jobs set
        payload = payload - 'audioBlobKey' - 'audioOriginalFilename',
        updated_at = now()
      where id = ${item.jobId} and handover_id = ${item.handoverId}
        and revision = ${item.revision}
        and nullif(btrim(payload ->> 'audioBlobKey'), '') = ${item.blobKey}
    `)
    let outcome = deleted ? 'deleted' : 'already-missing'
    if (!await completeClaimedResourceCleanupInTransaction(tx, { id: item.id, workerId, outcome })) {
      throw new Error('Lost audio cleanup claim before completion.')
    }
    return deleted
      ? { status: 'deleted', referencesCleared: true, cleanupId: item.id } as const
      : { status: 'already-missing', referencesCleared: true, cleanupId: item.id } as const
  })
}

async function processClaimedAudio(
  db: Database,
  storage: Pick<UploadStorage, 'delete'>,
  item: ResourceCleanupItem,
  workerId: string,
  retryBaseMs: number,
): Promise<SuccessfulTranscriptionAudioRetentionResult> {
  let deferred = await prepareClaim(db, item, workerId, retryBaseMs)
  if (deferred === 'lost-claim') return { status: 'scheduled', cleanupId: item.id }
  if (deferred) return { status: 'deferred', reason: deferred, cleanupId: item.id }

  // External object deletion is intentionally outside every database
  // transaction. The running outbox row is the durable coordination state.
  let deleted: boolean
  try {
    deleted = await storage.delete(item.blobKey!)
  } catch {
    await failClaimedResourceCleanup(db, {
      id: item.id,
      workerId,
      errorMessage: 'Local audio object deletion failed.',
      retryMs: retryDelay(item.attempts, retryBaseMs),
    })
    return { status: 'delete-failed', referencesCleared: false, cleanupId: item.id }
  }
  return finalizeDeletedAudio(db, item, workerId, deleted, retryBaseMs)
}

async function resultForUnclaimed(
  db: Database,
  cleanupId: string,
): Promise<SuccessfulTranscriptionAudioRetentionResult> {
  let current = await getResourceCleanupById(db, cleanupId)
  if (!current) return { status: 'scheduled', cleanupId }
  if (current.status === 'completed') {
    return current.outcome === 'already-missing'
      ? { status: 'already-missing', referencesCleared: true, cleanupId }
      : { status: 'deleted', referencesCleared: true, cleanupId }
  }
  if (current.status === 'deferred') {
    let reason: DeferredReason = current.lastError === 'shared-audio-reference'
      ? 'shared-audio-reference'
      : 'active-transcription-reference'
    return { status: 'deferred', reason, cleanupId }
  }
  if (current.status === 'failed') return { status: 'delete-failed', referencesCleared: false, cleanupId }
  return { status: 'scheduled', cleanupId }
}

/**
 * Schedules successful real-audio cleanup durably, then makes one immediate
 * best-effort attempt. A crash or storage failure leaves an auditable outbox row
 * for `processNext()` to reclaim later with SKIP LOCKED.
 */
export function createSuccessfulTranscriptionAudioRetention(input: RetentionOptions): SuccessfulTranscriptionAudioRetention {
  let retain = retainUploadedAudioAfterTranscription(input.env)
  let workerId = input.workerId?.trim() || `audio-cleanup-${randomUUID()}`
  let lockMs = positiveInteger(input.lockMs ?? 60_000, 'lockMs')
  let retryBaseMs = positiveInteger(input.retryBaseMs ?? 30_000, 'retryBaseMs')

  return {
    async release(request) {
      if (retain && !request.deletionRequired) return { status: 'retained-by-policy' }
      let blobKey = nonEmpty(request.processedAudioBlobKey)
      if (!blobKey) return { status: 'no-processed-audio' }
      positiveInteger(request.revision, 'revision')

      let scheduled: { item: ResourceCleanupItem } | {
        result: Extract<SuccessfulTranscriptionAudioRetentionResult, { status: 'not-eligible' }>
      } = await input.db.transaction(async (tx) => {
        // The normal path already has atomic cleanup intent. A lock-free first
        // read avoids taking handover/job locks merely to drain that committed
        // row; a miss is rechecked under the full lock order below.
        let observed = await getResourceCleanupForIdentity(tx, {
          kind: LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
          resourceId: blobKey,
          handoverId: request.handoverId,
          jobId: request.jobId,
          revision: request.revision,
        })
        if (observed && (!request.deletionRequired || observed.deletionRequired)) {
          return { item: observed } as const
        }

        let ineligibleReason: 'job-mismatch' | 'transcript-not-persisted' | 'mock-transcription' = 'job-mismatch'
        let item = await enqueueResourceCleanupIfEligibleInTransaction(tx, {
          kind: LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
          resourceId: blobKey,
          blobKey,
          handoverId: request.handoverId,
          jobId: request.jobId,
          revision: request.revision,
          deletionRequired: request.deletionRequired,
        }, async () => {
          let eligibility = await tx.exec(sql`
            select
              j.payload ->> 'audioBlobKey' as payload_audio_blob_key,
              h.transcription_metadata is not null as metadata_persisted,
              h.transcription_metadata ->> 'mocked' as metadata_mocked,
              exists (
                select 1 from transcription_runs completed_run
                where completed_run.job_id = j.id
                  and completed_run.handover_id = h.id
                  and completed_run.revision = j.revision
                  and completed_run.status = 'completed'
              ) as run_confirmed
            from handover_jobs j
            join handovers h on h.id = j.handover_id
            where j.id = ${request.jobId}
              and j.handover_id = ${request.handoverId}
              and j.revision = ${request.revision}
              and j.status in ('running', 'completed')
            for update of j, h
          `)
          let row = eligibility.rows?.[0]
          if (!row || nonEmpty(typeof row.payload_audio_blob_key === 'string' ? row.payload_audio_blob_key : null) !== blobKey) {
            ineligibleReason = 'job-mismatch'
            return false
          }
          if (!isTrue(row.metadata_persisted) || !isTrue(row.run_confirmed)) {
            ineligibleReason = 'transcript-not-persisted'
            return false
          }
          if (!isFalse(row.metadata_mocked)) {
            ineligibleReason = 'mock-transcription'
            return false
          }
          return true
        })
        if (!item) return { result: { status: 'not-eligible', reason: ineligibleReason } as const }
        return { item } as const
      })
      if ('result' in scheduled) return scheduled.result

      let claimed = await claimResourceCleanupById(input.db, {
        id: scheduled.item.id,
        kind: LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
        workerId,
        lockMs,
      })
      return claimed
        ? processClaimedAudio(input.db, input.storage, claimed, workerId, retryBaseMs)
        : resultForUnclaimed(input.db, scheduled.item.id)
    },

    async confirmRequiredDeletion(request) {
      positiveInteger(request.revision, 'revision')
      let item = await getRequiredResourceCleanupForJob(input.db, {
        kind: LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
        jobId: request.jobId,
        revision: request.revision,
      })
      if (!item) return { status: 'not-eligible', reason: 'job-mismatch' }
      let claimed = await claimResourceCleanupById(input.db, {
        id: item.id,
        kind: LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
        workerId,
        lockMs,
      })
      return claimed
        ? processClaimedAudio(input.db, input.storage, claimed, workerId, retryBaseMs)
        : resultForUnclaimed(input.db, item.id)
    },

    async processNext() {
      // Retention policy controls whether successful transcription schedules
      // cleanup. It must not prevent the generic queue from draining cleanup
      // intents created by explicit handover deletion or inbox dismissal.
      let claimed = retain
        ? await claimNextResourceCleanup(input.db, {
            kind: LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
            workerId,
            lockMs,
            deletionRequired: true,
          }) ?? await claimNextResourceCleanup(input.db, {
            kind: LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
            workerId,
            lockMs,
            jobIdPrefix: PROVISIONAL_AUDIO_UPLOAD_JOB_PREFIX,
          }) ?? await claimNextResourceCleanup(input.db, {
            kind: LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
            workerId,
            lockMs,
            jobIdPrefix: EXPLICIT_AUDIO_DELETION_JOB_PREFIX,
          })
        : await claimNextResourceCleanup(input.db, {
            kind: LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
            workerId,
            lockMs,
          })
      return claimed
        ? processClaimedAudio(input.db, input.storage, claimed, workerId, retryBaseMs)
        : { status: 'no-work' }
    },
  }
}
