import { createHash, randomUUID } from 'node:crypto'

import { sql, type Database } from 'remix/data-table'

import type { ResourceCleanupStatus } from './schema.ts'

export const LOCAL_AUDIO_OBJECT_CLEANUP_KIND = 'local-audio-object'
export const EXPLICIT_AUDIO_DELETION_JOB_PREFIX = 'explicit-audio-deletion:'
export const PROVISIONAL_AUDIO_UPLOAD_JOB_PREFIX = 'provisional-audio-upload:'
const DEFAULT_PROVISIONAL_AUDIO_CLEANUP_DELAY_MS = 60 * 60 * 1_000

const CLEANUP_ADVISORY_LOCK_SEED = 6_841_927_441_337_031

export type ResourceCleanupItem = {
  id: string
  kind: string
  resourceId: string
  blobKey: string | null
  handoverId: string
  jobId: string
  revision: number
  deletionRequired: boolean
  status: ResourceCleanupStatus
  attempts: number
  nextRetryAt: Date
  lockedBy: string | null
  lockedUntil: Date | null
  lastError: string | null
  outcome: string | null
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
  updatedAt: Date
}

export type EnqueueResourceCleanupInput = {
  id?: string
  kind: string
  resourceId: string
  blobKey?: string | null
  handoverId: string
  jobId: string
  revision: number
  /** Privacy-sensitive cleanup must drain even when ordinary retention is enabled. */
  deletionRequired?: boolean
}

export class ResourceCleanupConflictError extends Error {}
export class ProvisionalAudioCleanupBusyError extends Error {
  status = 503
  constructor() {
    super('This recording upload is still being cleaned up. Retry shortly.')
  }
}

function nonEmpty(value: string | null | undefined, name: string): string {
  let normalized = value?.trim() ?? ''
  if (!normalized) throw new TypeError(`${name} is required`)
  return normalized
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`)
  return value
}

function date(value: unknown): Date {
  if (value instanceof Date) return value
  let parsed = new Date(String(value))
  if (!Number.isFinite(parsed.getTime())) throw new TypeError('Invalid cleanup timestamp')
  return parsed
}

function nullableDate(value: unknown): Date | null {
  return value == null ? null : date(value)
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function parseStatus(value: unknown): ResourceCleanupStatus {
  if (value === 'queued' || value === 'running' || value === 'deferred' || value === 'completed' || value === 'failed') {
    return value
  }
  throw new TypeError('Invalid cleanup status')
}

function parseItem(row: Record<string, unknown>): ResourceCleanupItem {
  return {
    id: String(row.id),
    kind: String(row.kind),
    resourceId: String(row.resource_id),
    blobKey: nullableString(row.blob_key),
    handoverId: String(row.handover_id),
    jobId: String(row.job_id),
    revision: positiveInteger(Number(row.revision), 'revision'),
    deletionRequired: row.deletion_required === true || row.deletion_required === 'true',
    status: parseStatus(row.status),
    attempts: Number(row.attempts),
    nextRetryAt: date(row.next_retry_at),
    lockedBy: nullableString(row.locked_by),
    lockedUntil: nullableDate(row.locked_until),
    lastError: nullableString(row.last_error),
    outcome: nullableString(row.outcome),
    createdAt: date(row.created_at),
    startedAt: nullableDate(row.started_at),
    completedAt: nullableDate(row.completed_at),
    updatedAt: date(row.updated_at),
  }
}

function normalizedInput(input: EnqueueResourceCleanupInput): Required<EnqueueResourceCleanupInput> {
  let kind = nonEmpty(input.kind, 'kind')
  let resourceId = nonEmpty(input.resourceId, 'resourceId')
  let blobKey = input.blobKey?.trim() || null
  if (kind === LOCAL_AUDIO_OBJECT_CLEANUP_KIND && (!blobKey || blobKey !== resourceId)) {
    throw new TypeError('Local audio cleanup requires resourceId and blobKey to match')
  }
  return {
    id: input.id?.trim() || randomUUID(),
    kind,
    resourceId,
    blobKey,
    handoverId: nonEmpty(input.handoverId, 'handoverId'),
    jobId: nonEmpty(input.jobId, 'jobId'),
    revision: positiveInteger(input.revision, 'revision'),
    deletionRequired: input.deletionRequired === true,
  }
}

/**
 * Acquires the transaction-scoped lock shared by cleanup and reference writes.
 * The caller MUST pass a Database bound to an open transaction; PostgreSQL
 * releases this lock automatically when that transaction commits or rolls back.
 */
export async function lockCleanupResourceForTransaction(
  db: Database,
  kind: string,
  resourceId: string,
): Promise<void> {
  // JSON string encoding is unambiguous for the pair and, unlike a NUL
  // separator, is valid PostgreSQL UTF-8 text.
  let key = JSON.stringify([nonEmpty(kind, 'kind'), nonEmpty(resourceId, 'resourceId')])
  await db.exec(sql`
    select pg_advisory_xact_lock(hashtextextended(${key}, ${CLEANUP_ADVISORY_LOCK_SEED}::bigint))
  `)
}

/**
 * Exact lock helper for every repository transaction that assigns an existing
 * audio blob key to handovers, handover_audio, or a job payload. Call this
 * before writing any reference. It rejects keys with durable cleanup intent,
 * including completed rows whose object is already gone.
 */
export async function lockAudioBlobKeyForReferenceAssignment(db: Database, blobKey: string): Promise<void> {
  let key = nonEmpty(blobKey, 'blobKey')
  await lockCleanupResourceForTransaction(db, LOCAL_AUDIO_OBJECT_CLEANUP_KIND, key)
  let conflict = await db.exec(sql`
    select id, status from resource_cleanup_outbox
    where kind = ${LOCAL_AUDIO_OBJECT_CLEANUP_KIND} and blob_key = ${key}
    order by created_at desc limit 1
  `)
  if (conflict.rows?.[0]) {
    throw new ResourceCleanupConflictError('The audio object is already scheduled for cleanup.')
  }
}

/**
 * Use inside an existing transaction when eligibility and enqueue must commit
 * atomically. Existing identities follow the worker's row-lock -> advisory-lock
 * order. A missing identity takes the advisory lock and is rechecked before the
 * eligibility decision and insert.
 */
export async function enqueueResourceCleanupIfEligibleInTransaction(
  db: Database,
  rawInput: EnqueueResourceCleanupInput,
  isEligible: () => Promise<boolean>,
): Promise<ResourceCleanupItem | null> {
  let input = normalizedInput(rawInput)
  let selectExisting = () => db.exec(sql`
    select * from resource_cleanup_outbox
    where kind = ${input.kind} and resource_id = ${input.resourceId}
      and handover_id = ${input.handoverId} and job_id = ${input.jobId}
      and revision = ${input.revision}
    for update
  `)
  let existing = await selectExisting()
  if (existing.rows?.[0]) {
    await lockCleanupResourceForTransaction(db, input.kind, input.resourceId)
    if (input.deletionRequired && existing.rows[0].deletion_required !== true) {
      let upgraded = await db.exec(sql`
        update resource_cleanup_outbox set deletion_required = true, updated_at = now()
        where id = ${String(existing.rows[0].id)}
        returning *
      `)
      return upgraded.rows?.[0] ? parseItem(upgraded.rows[0]) : null
    }
    return parseItem(existing.rows[0])
  }

  await lockCleanupResourceForTransaction(db, input.kind, input.resourceId)
  existing = await selectExisting()
  if (existing.rows?.[0]) {
    if (input.deletionRequired && existing.rows[0].deletion_required !== true) {
      let upgraded = await db.exec(sql`
        update resource_cleanup_outbox set deletion_required = true, updated_at = now()
        where id = ${String(existing.rows[0].id)}
        returning *
      `)
      return upgraded.rows?.[0] ? parseItem(upgraded.rows[0]) : null
    }
    return parseItem(existing.rows[0])
  }
  if (!(await isEligible())) return null

  let result = await db.exec(sql`
    insert into resource_cleanup_outbox(
      id, kind, resource_id, blob_key, handover_id, job_id, revision, deletion_required, status,
      attempts, next_retry_at, created_at, updated_at
    ) values(
      ${input.id}, ${input.kind}, ${input.resourceId}, ${input.blobKey}, ${input.handoverId},
      ${input.jobId}, ${input.revision}, ${input.deletionRequired}, 'queued', 0, now(), now(), now()
    )
    returning *
  `)
  let row = result.rows?.[0]
  if (!row) throw new Error('Cleanup enqueue did not return a row.')
  return parseItem(row)
}

/** Use inside an existing transaction when cleanup is unconditionally eligible. */
export async function enqueueResourceCleanupInTransaction(
  db: Database,
  input: EnqueueResourceCleanupInput,
): Promise<ResourceCleanupItem> {
  let item = await enqueueResourceCleanupIfEligibleInTransaction(db, input, async () => true)
  if (!item) throw new Error('Unconditional cleanup enqueue was rejected.')
  return item
}

function provisionalAudioIdentity(userId: string, recordingUploadId: string) {
  let scope = createHash('sha256')
    .update(JSON.stringify([nonEmpty(userId, 'userId'), nonEmpty(recordingUploadId, 'recordingUploadId')]))
    .digest('hex')
  return {
    handoverId: `${PROVISIONAL_AUDIO_UPLOAD_JOB_PREFIX}${scope}`,
    jobId: `${PROVISIONAL_AUDIO_UPLOAD_JOB_PREFIX}${scope}`,
  }
}

/**
 * Persist cleanup intent before contacting object storage. Retries for the same
 * authenticated upload and content key share one row, so a losing concurrent
 * replay cannot later delete the winning request's deterministic object.
 */
export async function enqueueProvisionalAudioUploadCleanup(db: Database, input: {
  blobKey: string
  userId: string
  recordingUploadId: string
  delayMs?: number
}): Promise<ResourceCleanupItem> {
  let blobKey = nonEmpty(input.blobKey, 'blobKey')
  let delayMs = positiveInteger(input.delayMs ?? DEFAULT_PROVISIONAL_AUDIO_CLEANUP_DELAY_MS, 'delayMs')
  let identity = provisionalAudioIdentity(input.userId, input.recordingUploadId)
  return db.transaction(async (tx) => {
    let selectExisting = () => tx.exec(sql`
      select * from resource_cleanup_outbox
      where kind = ${LOCAL_AUDIO_OBJECT_CLEANUP_KIND} and resource_id = ${blobKey}
        and blob_key = ${blobKey} and handover_id = ${identity.handoverId}
        and job_id = ${identity.jobId} and revision = 1
      for update
    `)
    // Existing rows follow the worker's row-lock -> advisory-lock order. On a
    // miss, the advisory lock serializes insertions and the mandatory recheck
    // observes any winner that committed while this transaction waited.
    let existing = await selectExisting()
    if (existing.rows?.[0]) {
      await lockCleanupResourceForTransaction(tx, LOCAL_AUDIO_OBJECT_CLEANUP_KIND, blobKey)
    } else {
      await lockCleanupResourceForTransaction(tx, LOCAL_AUDIO_OBJECT_CLEANUP_KIND, blobKey)
      existing = await selectExisting()
    }
    let row = existing.rows?.[0]
    if (row && row.status === 'running') throw new ProvisionalAudioCleanupBusyError()
    let result = row
      ? await tx.exec(sql`
          update resource_cleanup_outbox set
            status = 'queued', attempts = 0,
            next_retry_at = now() + (${delayMs}::text || ' milliseconds')::interval,
            locked_by = null, locked_until = null, last_error = null, outcome = null,
            started_at = null, completed_at = null, updated_at = now()
          where id = ${String(row.id)}
          returning *
        `)
      : await tx.exec(sql`
          insert into resource_cleanup_outbox(
            id, kind, resource_id, blob_key, handover_id, job_id, revision, status,
            attempts, next_retry_at, created_at, updated_at
          ) values(
            ${randomUUID()}, ${LOCAL_AUDIO_OBJECT_CLEANUP_KIND}, ${blobKey}, ${blobKey},
            ${identity.handoverId}, ${identity.jobId}, 1, 'queued', 0,
            now() + (${delayMs}::text || ' milliseconds')::interval, now(), now()
          )
          returning *
        `)
    let saved = result.rows?.[0]
    if (!saved) throw new Error('Provisional audio cleanup enqueue did not return a row.')
    return parseItem(saved)
  })
}

/**
 * Consume only the exact provisional row in the same transaction that first
 * publishes clinical references to the object. Any other cleanup intent for
 * the key remains an assignment conflict.
 */
export async function consumeProvisionalAudioUploadCleanupInTransaction(db: Database, input: {
  cleanupId: string
  blobKey: string
  userId: string
  recordingUploadId: string
  allowMissing?: boolean
}): Promise<void> {
  let cleanupId = nonEmpty(input.cleanupId, 'cleanupId')
  let blobKey = nonEmpty(input.blobKey, 'blobKey')
  let identity = provisionalAudioIdentity(input.userId, input.recordingUploadId)
  // Match the worker's row-lock -> advisory-lock order.
  let selected = await db.exec(sql`
    select * from resource_cleanup_outbox
    where id = ${cleanupId} and kind = ${LOCAL_AUDIO_OBJECT_CLEANUP_KIND}
      and resource_id = ${blobKey} and blob_key = ${blobKey}
      and handover_id = ${identity.handoverId} and job_id = ${identity.jobId}
      and revision = 1
    for update
  `)
  let row = selected.rows?.[0]
  if (!row) {
    if (input.allowMissing) return
    throw new ResourceCleanupConflictError('The recording cleanup intent is no longer available.')
  }
  if (row.status === 'running') throw new ProvisionalAudioCleanupBusyError()
  if (row.status === 'completed') {
    throw new ResourceCleanupConflictError('The recording object has already been cleaned up.')
  }
  await lockCleanupResourceForTransaction(db, LOCAL_AUDIO_OBJECT_CLEANUP_KIND, blobKey)
  let conflict = await db.exec(sql`
    select id from resource_cleanup_outbox
    where kind = ${LOCAL_AUDIO_OBJECT_CLEANUP_KIND} and blob_key = ${blobKey} and id <> ${cleanupId}
    limit 1
  `)
  if (conflict.rows?.[0]) throw new ResourceCleanupConflictError('The audio object is already scheduled for cleanup.')
  let removed = await db.exec(sql`delete from resource_cleanup_outbox where id = ${cleanupId} returning id`)
  if (!removed.rows?.[0]) throw new ResourceCleanupConflictError('The recording cleanup intent could not be consumed.')
}

function claimableSql(
  id: string | null,
  kind: string,
  jobIdPrefix: string | null = null,
  deletionRequired: boolean | null = null,
) {
  return sql`
    select * from resource_cleanup_outbox
    where kind = ${kind}
      ${id ? sql`and id = ${id}` : sql``}
      ${jobIdPrefix ? sql`and left(job_id, char_length(${jobIdPrefix})) = ${jobIdPrefix}` : sql``}
      ${deletionRequired == null ? sql`` : sql`and deletion_required = ${deletionRequired}`}
      and (
        (status in ('queued', 'deferred', 'failed') and next_retry_at <= now())
        or (status = 'running' and locked_until is not null and locked_until < now())
      )
    order by next_retry_at, created_at, id
    for update skip locked
    limit 1
  `
}

async function claimResourceCleanup(
  db: Database,
  input: {
    id?: string
    kind: string
    workerId: string
    lockMs: number
    jobIdPrefix?: string
    deletionRequired?: boolean
  },
): Promise<ResourceCleanupItem | null> {
  let kind = nonEmpty(input.kind, 'kind')
  let workerId = nonEmpty(input.workerId, 'workerId')
  let lockMs = positiveInteger(input.lockMs, 'lockMs')
  let jobIdPrefix = input.jobIdPrefix == null ? null : nonEmpty(input.jobIdPrefix, 'jobIdPrefix')
  return db.transaction(async (tx) => {
    let candidate = await tx.exec(claimableSql(
      input.id?.trim() || null,
      kind,
      jobIdPrefix,
      input.deletionRequired ?? null,
    ))
    let row = candidate.rows?.[0]
    if (!row) return null
    let item = parseItem(row)
    await lockCleanupResourceForTransaction(tx, item.kind, item.resourceId)
    let claimed = await tx.exec(sql`
      update resource_cleanup_outbox set
        status = 'running', attempts = attempts + 1, locked_by = ${workerId},
        locked_until = now() + (${lockMs}::text || ' milliseconds')::interval,
        started_at = coalesce(started_at, now()), completed_at = null,
        last_error = null, outcome = null, updated_at = now()
      where id = ${item.id}
      returning *
    `)
    return claimed.rows?.[0] ? parseItem(claimed.rows[0]) : null
  })
}

export function claimNextResourceCleanup(
  db: Database,
  input: {
    kind: string
    workerId: string
    lockMs: number
    jobIdPrefix?: string
    deletionRequired?: boolean
  },
): Promise<ResourceCleanupItem | null> {
  return claimResourceCleanup(db, input)
}

export function claimResourceCleanupById(
  db: Database,
  input: { id: string; kind: string; workerId: string; lockMs: number },
): Promise<ResourceCleanupItem | null> {
  nonEmpty(input.id, 'id')
  return claimResourceCleanup(db, input)
}

function boundedMessage(value: string): string {
  let normalized = value.trim().replace(/\s+/g, ' ')
  return (normalized || 'Cleanup could not be completed.').slice(0, 240)
}

async function rescheduleClaimedResourceCleanup(
  db: Database,
  input: {
    id: string
    workerId: string
    status: 'deferred' | 'failed'
    message: string
    retryMs: number
  },
): Promise<boolean> {
  let retryMs = positiveInteger(input.retryMs, 'retryMs')
  let result = await db.exec(sql`
    update resource_cleanup_outbox set
      status = ${input.status}, locked_by = null, locked_until = null,
      next_retry_at = now() + (${retryMs}::text || ' milliseconds')::interval,
      last_error = ${boundedMessage(input.message)}, updated_at = now()
    where id = ${nonEmpty(input.id, 'id')} and status = 'running'
      and locked_by = ${nonEmpty(input.workerId, 'workerId')}
    returning id
  `)
  return (result.rows?.length ?? 0) === 1
}

export function deferClaimedResourceCleanup(
  db: Database,
  input: { id: string; workerId: string; reason: string; retryMs: number },
): Promise<boolean> {
  return rescheduleClaimedResourceCleanup(db, { ...input, status: 'deferred', message: input.reason })
}

export function failClaimedResourceCleanup(
  db: Database,
  input: { id: string; workerId: string; errorMessage: string; retryMs: number },
): Promise<boolean> {
  return rescheduleClaimedResourceCleanup(db, { ...input, status: 'failed', message: input.errorMessage })
}

export async function getResourceCleanupById(db: Database, id: string): Promise<ResourceCleanupItem | null> {
  let result = await db.exec(sql`select * from resource_cleanup_outbox where id = ${nonEmpty(id, 'id')} limit 1`)
  return result.rows?.[0] ? parseItem(result.rows[0]) : null
}

export async function getResourceCleanupForIdentity(
  db: Database,
  rawInput: Pick<EnqueueResourceCleanupInput, 'kind' | 'resourceId' | 'handoverId' | 'jobId' | 'revision'>,
): Promise<ResourceCleanupItem | null> {
  let kind = nonEmpty(rawInput.kind, 'kind')
  let resourceId = nonEmpty(rawInput.resourceId, 'resourceId')
  let handoverId = nonEmpty(rawInput.handoverId, 'handoverId')
  let jobId = nonEmpty(rawInput.jobId, 'jobId')
  let revision = positiveInteger(rawInput.revision, 'revision')
  let result = await db.exec(sql`
    select * from resource_cleanup_outbox
    where kind = ${kind} and resource_id = ${resourceId} and handover_id = ${handoverId}
      and job_id = ${jobId} and revision = ${revision}
    limit 1
  `)
  return result.rows?.[0] ? parseItem(result.rows[0]) : null
}

/** Resolve the original transcription cleanup after an analysis-only job copy. */
export async function getRequiredResourceCleanupForJob(
  db: Database,
  input: { kind: string; jobId: string; revision: number },
): Promise<ResourceCleanupItem | null> {
  let kind = nonEmpty(input.kind, 'kind')
  let jobId = nonEmpty(input.jobId, 'jobId')
  let revision = positiveInteger(input.revision, 'revision')
  let result = await db.exec(sql`
    select * from resource_cleanup_outbox
    where kind = ${kind} and job_id = ${jobId} and revision = ${revision}
      and deletion_required = true
    order by created_at, id
    limit 1
  `)
  return result.rows?.[0] ? parseItem(result.rows[0]) : null
}

/**
 * Upgrade the one durable cleanup identity owned by an earlier job/revision.
 * This is used when a retry tightens its privacy mode after transcription has
 * already completed. Multiple identities are treated as ambiguous rather
 * than guessing which audio object must gate the retry.
 */
export async function requireExistingResourceCleanupForJobInTransaction(
  db: Database,
  input: { kind: string; jobId: string; revision: number },
): Promise<ResourceCleanupItem | null> {
  let kind = nonEmpty(input.kind, 'kind')
  let jobId = nonEmpty(input.jobId, 'jobId')
  let revision = positiveInteger(input.revision, 'revision')
  let result = await db.exec(sql`
    select * from resource_cleanup_outbox
    where kind = ${kind} and job_id = ${jobId} and revision = ${revision}
    order by created_at, id
    for update
  `)
  let rows = result.rows ?? []
  if (rows.length > 1) {
    throw new ResourceCleanupConflictError('Multiple cleanup identities exist for this transcription job.')
  }
  if (!rows[0]) return null

  let item = parseItem(rows[0])
  await lockCleanupResourceForTransaction(db, item.kind, item.resourceId)
  if (item.deletionRequired) return item
  let upgraded = await db.exec(sql`
    update resource_cleanup_outbox set deletion_required = true, updated_at = now()
    where id = ${item.id}
    returning *
  `)
  let row = upgraded.rows?.[0]
  if (!row) throw new Error('Required cleanup upgrade did not return a row.')
  return parseItem(row)
}

/**
 * Caller must hold the resource advisory lock and clear exact references in
 * this same transaction before marking the claimed cleanup complete.
 */
export async function completeClaimedResourceCleanupInTransaction(
  db: Database,
  input: { id: string; workerId: string; outcome: string },
): Promise<boolean> {
  let result = await db.exec(sql`
    update resource_cleanup_outbox set
      status = 'completed', locked_by = null, locked_until = null,
      next_retry_at = now(), last_error = null, outcome = ${nonEmpty(input.outcome, 'outcome')},
      completed_at = now(), updated_at = now()
    where id = ${nonEmpty(input.id, 'id')} and status = 'running'
      and locked_by = ${nonEmpty(input.workerId, 'workerId')}
    returning id
  `)
  return (result.rows?.length ?? 0) === 1
}
