import { sql, type Database } from 'remix/data-table'
import { createHash, randomUUID } from 'node:crypto'
import type {
  HandoverSheetColumnKey,
  HandoverSheetExtraction,
  HandoverSheetPatientField,
  HandoverSheetReviewDecision,
} from './handover-sheet.ts'
import { handoverSheetColumns, handoverSheetLabels, normalizeStoredHandoverSheetFields } from './handover-sheet.ts'
import type {
  HandoverSheetSbarReconciliationChange,
  HandoverSheetSbarReconciliationInput,
} from '../domain/handover-sheet-reconciliation.server.ts'
import type { AnalysisSummary, DspySpan } from '../domain/handover-analysis.server.ts'
import { applyLocalPrivacyExceptions, type LocalPrivacyAllowedFinding } from '../domain/local-privacy.server.ts'
import type { ReviewTranscriptPrivacyAudit, ReviewTranscriptPrivacyFinding } from '../utils/handover-review.ts'
import {
  consumeProvisionalAudioUploadCleanupInTransaction,
  enqueueResourceCleanupIfEligibleInTransaction,
  EXPLICIT_AUDIO_DELETION_JOB_PREFIX,
  LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
  lockAudioBlobKeyForReferenceAssignment,
} from './resource-cleanup.ts'
import { requireSuccessfulTranscriptionAudioCleanupInTransaction } from './audio-retention.ts'
import { notifyHandoverJobQueued } from './handover-job-wakeup.ts'
import { notifyHandoverProcessingChanged } from './handover-processing-events.ts'
import { currentPrivacyPolicyVersion } from './local-first-processing.ts'
import { lockHandoverPrivacyFamilyForTransaction, ratchetHandoverPrivacyFamily } from './queue.ts'
import {
  normalizePatientKey,
  resolvePatientIdentityReferences,
  safePlaceholderPatientAliasKeys,
} from './patient-identity.ts'
import { removeTranscriptionTail, type TranscriptionMetadata } from './transcription.ts'
import {
  handoverBookmarks,
  handoverAudio,
  handoverJobs,
  handoverAssignments,
  handoverPatients,
  handoverRecordingUploads,
  handoverTasks,
  handovers,
  shifts,
  shiftSheetPatients,
  users,
  type HandoverRow,
  type HandoverJobRow,
  type HandoverRecordingUploadRow,
  type HandoverPatientRow,
  type HandoverTaskRow,
  type HandoverTaskStatus,
  type ShiftSheetPatientRow,
  type ShiftRow,
  type UserRow,
} from './schema.ts'

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function stringArray(value: unknown): string[] {
  let decoded = jsonValue(value)
  return Array.isArray(decoded) ? decoded.filter((item): item is string => typeof item === 'string') : []
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  let decoded = jsonValue(value)
  return Array.isArray(decoded)
    ? decoded.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
    : []
}

function storedParticipantNames(value: unknown): string[] {
  return objectArray(value)
    .map((participant) => typeof participant.name === 'string' ? participant.name.trim() : '')
    .filter(Boolean)
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function objectValue(value: unknown): Record<string, unknown> | null {
  let decoded = jsonValue(value)
  return typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded) ? decoded as Record<string, unknown> : null
}

function shiftRow(row: ShiftRow): ShiftRow {
  return { ...row, assigned_user_ids: stringArray(row.assigned_user_ids), patient_order: stringArray(row.patient_order) }
}

function handoverRow(row: HandoverRow): HandoverRow {
  return {
    ...row,
    participants: objectArray(row.participants),
    shared_with_user_ids: stringArray(row.shared_with_user_ids),
    transcription_metadata: objectValue(row.transcription_metadata),
    analysis: objectValue(row.analysis),
  }
}

export async function getUser(db: Database, id: string): Promise<UserRow | null> {
  return db.find(users, id)
}

export async function getLocalFirstProcessingPreferenceForUser(
  db: Database,
  userId: string,
): Promise<boolean> {
  let user = await getUser(db, userId)
  return user?.local_first_processing_enabled === true
}

export async function updateLocalFirstProcessingPreferenceForUser(
  db: Database,
  input: { userId: string; enabled: boolean },
): Promise<boolean | null> {
  let result = await db.exec(sql`
    update users
    set local_first_processing_enabled = ${input.enabled}, updated_at = now()
    where id = ${input.userId}
    returning local_first_processing_enabled
  `)
  let updated = result.rows?.[0]?.local_first_processing_enabled
  return updated === true || updated === false ? updated : null
}

/** Returns whether any contributing handover has crossed the local-first boundary. */
export async function handoversHaveLocalFirstProcessingHistory(
  db: Database,
  handoverIds: readonly string[],
): Promise<boolean> {
  let ids = [...new Set(handoverIds.map((id) => id.trim()).filter(Boolean))]
  if (ids.length === 0) return false
  let result = await db.exec(sql`
    select exists(
      select 1 from handovers handover
      where handover.id in (
        select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)
      ) and (
        handover.privacy_mode_floor = 'local-first'
        or exists (
          select 1 from handover_jobs job
          where job.handover_id = handover.id
            and job.payload ->> 'privacyMode' = 'local-first'
        )
      )
    ) as local_first_history
  `)
  let value = result.rows?.[0]?.local_first_history
  return value === true || value === 'true'
}

export async function listUsers(db: Database): Promise<UserRow[]> {
  return db.findMany(users, { orderBy: ['full_name', 'asc'] })
}

export async function upsertUser(db: Database, input: {
  id: string; fullName: string; occupation: string; department: string
}): Promise<UserRow> {
  let now = new Date()
  let result = await db.exec(sql`
    insert into users (id, full_name, occupation, department, created_at, updated_at, last_active_at)
    values (${input.id}, ${input.fullName}, ${input.occupation}, ${input.department}, ${now}, ${now}, ${now})
    on conflict (id) do update set
      full_name = excluded.full_name, occupation = excluded.occupation,
      department = excluded.department, updated_at = excluded.updated_at,
      last_active_at = excluded.last_active_at
    returning *
  `)
  return result.rows![0] as UserRow
}

export async function listHandoversForUser(db: Database, userId: string): Promise<HandoverRow[]> {
  let result = await db.exec(sql`
    select distinct h.* from handovers h
    left join shifts s on s.id = h.shift_id
    left join handover_assignments a on a.handover_id = h.id
    where h.created_by_user_id = ${userId}
      or jsonb_exists(h.shared_with_user_ids, ${userId})
      or a.assigned_to_user_id = ${userId}
      or s.created_by_user_id = ${userId}
      or jsonb_exists(s.assigned_user_ids, ${userId})
    order by h.updated_at desc
  `)
  return ((result.rows ?? []) as HandoverRow[]).map(handoverRow)
}

export type ProcessingHandoverRow = Pick<
  HandoverRow,
  'id'
  | 'shift_id'
  | 'source_shift_id'
  | 'linked_patient_key'
  | 'linked_patient_display_name'
  | 'linked_patient_location'
  | 'processing_status'
  | 'version'
  | 'updated_at'
  | 'analysis'
> & { patient_keys: string[] }

/**
 * Lightweight polling projection for the shell-level processing coordinator.
 * Completed rows are intentionally absent: their disappearance is the signal
 * that native Remix Frames should reload their current document data.
 */
export async function listProcessingHandoversForUser(
  db: Database,
  userId: string,
  trackedIds: readonly string[] = [],
): Promise<ProcessingHandoverRow[]> {
  let boundedTrackedIds = [...new Set(trackedIds)].slice(0, 100)
  let result = await db.exec(sql`
    select distinct
      h.id,
      h.shift_id,
      h.source_shift_id,
      h.linked_patient_key,
      h.linked_patient_display_name,
      h.linked_patient_location,
      h.processing_status,
      h.version,
      h.updated_at,
      h.analysis,
      coalesce((
        select jsonb_agg(p.patient_key order by p.patient_key)
        from handover_patients p
        where p.handover_id = h.id
      ), '[]'::jsonb) as patient_keys
    from handovers h
    left join shifts s on s.id = h.shift_id
    left join handover_assignments a on a.handover_id = h.id
    where (
        h.processing_status in ('queued', 'transcribing', 'analysing')
        or h.id in (
          select jsonb_array_elements_text(${JSON.stringify(boundedTrackedIds)}::jsonb)
        )
      )
      and (
        h.created_by_user_id = ${userId}
        or jsonb_exists(h.shared_with_user_ids, ${userId})
        or a.assigned_to_user_id = ${userId}
        or s.created_by_user_id = ${userId}
        or jsonb_exists(s.assigned_user_ids, ${userId})
      )
    order by h.id asc
  `)
  return (result.rows ?? []) as ProcessingHandoverRow[]
}

export async function listShiftHandoverPatientsForUser(
  db: Database,
  input: { shiftId: string; userId: string },
): Promise<HandoverPatientRow[]> {
  let result = await db.exec(sql`
    select p.* from handover_patients p
    join handovers h on h.id = p.handover_id
    join shifts requested_shift on requested_shift.id = ${input.shiftId}
    left join shifts s on s.id = h.shift_id
    where (
        h.shift_id = ${input.shiftId}
        or (h.source_handover_id is null and h.source_shift_id = ${input.shiftId})
      )
      and (
        requested_shift.created_by_user_id = ${input.userId}
        or jsonb_exists(requested_shift.assigned_user_ids, ${input.userId})
      )
      and (
        h.created_by_user_id = ${input.userId}
        or jsonb_exists(h.shared_with_user_ids, ${input.userId})
        or s.created_by_user_id = ${input.userId}
        or jsonb_exists(s.assigned_user_ids, ${input.userId})
        or exists (
          select 1 from handover_assignments a
          where a.handover_id = h.id and a.assigned_to_user_id = ${input.userId}
        )
      )
    order by p.created_at desc
  `)
  return (result.rows ?? []) as HandoverPatientRow[]
}

/**
 * Shell-level projection read. The query count is constant regardless of the
 * number of accessible shifts and each returned row is still protected by the
 * normal handover and shift access rules.
 */
export async function listAccessibleShiftHandoverPatientsForUser(db: Database, userId: string): Promise<HandoverPatientRow[]> {
  let result = await db.exec(sql`
    select distinct p.* from handover_patients p
    join handovers h on h.id = p.handover_id
    left join shifts primary_shift on primary_shift.id = h.shift_id
    left join shifts source_shift on source_shift.id = h.source_shift_id
    where (
      h.created_by_user_id = ${userId}
      or jsonb_exists(h.shared_with_user_ids, ${userId})
      or exists (
        select 1 from handover_assignments a
        where a.handover_id = h.id and a.assigned_to_user_id = ${userId}
      )
      or primary_shift.created_by_user_id = ${userId}
      or jsonb_exists(primary_shift.assigned_user_ids, ${userId})
    ) and (
      primary_shift.created_by_user_id = ${userId}
      or jsonb_exists(primary_shift.assigned_user_ids, ${userId})
      or (
        h.source_handover_id is null
        and (
          source_shift.created_by_user_id = ${userId}
          or jsonb_exists(source_shift.assigned_user_ids, ${userId})
        )
      )
    )
    order by p.created_at desc
  `)
  return (result.rows ?? []) as HandoverPatientRow[]
}

export async function getHandoverForUser(db: Database, id: string, userId: string): Promise<HandoverRow | null> {
  let result = await db.exec(sql`
    select h.* from handovers h
    left join shifts s on s.id = h.shift_id
    where h.id = ${id} and (
      h.created_by_user_id = ${userId} or jsonb_exists(h.shared_with_user_ids, ${userId})
      or s.created_by_user_id = ${userId} or jsonb_exists(s.assigned_user_ids, ${userId})
      or exists (select 1 from handover_assignments a where a.handover_id = h.id and a.assigned_to_user_id = ${userId})
    ) limit 1
  `)
  let row = result.rows?.[0] as HandoverRow | undefined
  return row ? handoverRow(row) : null
}

type TranscriptPrivacyFindingComponent = ReviewTranscriptPrivacyFinding & {
  appliedInAudit: boolean
}

type TranscriptPrivacyAuditComponent = Omit<ReviewTranscriptPrivacyAudit, 'findings'> & {
  findings: TranscriptPrivacyFindingComponent[]
  revision: number
  sourceText: string
  sourceCodepointLength: number
  createdAtTimestamp: number
  audioCleanupDependencies: Array<{ jobId: string; revision: number }>
}

function parseTranscriptPrivacyAuditComponent(row: Record<string, unknown>): TranscriptPrivacyAuditComponent | null {
  if (typeof row.id !== 'string' || typeof row.source_text !== 'string') return null
  let revision = Number(row.revision)
  if (!Number.isSafeInteger(revision) || revision <= 0) return null

  let sourceSha256 = typeof row.source_sha256 === 'string' ? row.source_sha256 : ''
  let expectedSourceSha256 = createHash('sha256').update(row.source_text, 'utf8').digest('hex')
  if (sourceSha256 !== expectedSourceSha256) return null

  let sourceCodepoints = [...row.source_text]
  let rawActiveExceptions = jsonValue(row.active_exceptions)
  if (!Array.isArray(rawActiveExceptions)) return null
  let activeExceptions = new Map<string, string>()
  for (let value of rawActiveExceptions) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    let exception = value as Record<string, unknown>
    if (
      typeof exception.id !== 'string'
      || typeof exception.normalizedText !== 'string'
      || typeof exception.canonicalLabel !== 'string'
    ) return null
    activeExceptions.set(
      JSON.stringify([exception.normalizedText, exception.canonicalLabel]),
      exception.id,
    )
  }
  let rawFindings = jsonValue(row.findings)
  if (!Array.isArray(rawFindings)) return null
  let findings: TranscriptPrivacyFindingComponent[] = []
  for (let [index, value] of rawFindings.entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    let finding = value as Record<string, unknown>
    let ordinal = Number(finding.ordinal)
    let startCodepoint = Number(finding.startCodepoint)
    let endCodepoint = Number(finding.endCodepoint)
    let label = typeof finding.label === 'string' ? finding.label.trim() : ''
    let entityType = typeof finding.entityType === 'string' ? finding.entityType.trim() : ''
    let originalText = typeof finding.originalText === 'string' ? finding.originalText : null
    let confidence = finding.confidence == null ? null : Number(finding.confidence)
    let rawSources = jsonValue(finding.sources)
    if (
      ordinal !== index
      || !Number.isSafeInteger(startCodepoint)
      || !Number.isSafeInteger(endCodepoint)
      || startCodepoint < 0
      || endCodepoint <= startCodepoint
      || endCodepoint > sourceCodepoints.length
      || !label
      || !entityType
      || originalText == null
      || sourceCodepoints.slice(startCodepoint, endCodepoint).join('') !== originalText
      || (confidence != null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1))
      || !Array.isArray(rawSources)
      || rawSources.some((source) => typeof source !== 'string')
      || (finding.canonicalLabel != null && typeof finding.canonicalLabel !== 'string')
      || (finding.appliedExceptionId != null && typeof finding.appliedExceptionId !== 'string')
    ) return null
    let canonicalLabel = typeof finding.canonicalLabel === 'string' && finding.canonicalLabel.trim()
      ? finding.canonicalLabel.trim()
      : null
    let activeExceptionId = canonicalLabel == null
      ? undefined
      : activeExceptions.get(JSON.stringify([originalText.normalize('NFKC'), canonicalLabel.normalize('NFKC')]))
    findings.push({
      ordinal,
      sourceAuditId: row.id,
      sourceOrdinal: ordinal,
      allowedInAnalysis: activeExceptionId != null,
      appliedInAudit: activeExceptionId != null && finding.appliedExceptionId === activeExceptionId,
      label,
      entityType,
      canonicalLabel,
      startCodepoint,
      endCodepoint,
      confidence,
      sources: rawSources,
    })
  }

  let rawCleanupDependencies = row.audio_cleanup_dependencies == null
    ? []
    : jsonValue(row.audio_cleanup_dependencies)
  if (!Array.isArray(rawCleanupDependencies)) return null
  let audioCleanupDependencies: Array<{ jobId: string; revision: number }> = []
  let cleanupDependencyKeys = new Set<string>()
  for (let value of rawCleanupDependencies) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    let dependency = value as Record<string, unknown>
    let jobId = typeof dependency.jobId === 'string' ? dependency.jobId : ''
    let cleanupRevision = Number(dependency.revision)
    let key = JSON.stringify([jobId, cleanupRevision])
    if (
      !jobId
      || !Number.isSafeInteger(cleanupRevision)
      || cleanupRevision <= 0
      || cleanupDependencyKeys.has(key)
    ) return null
    cleanupDependencyKeys.add(key)
    audioCleanupDependencies.push({ jobId, revision: cleanupRevision })
  }

  let replacementCount = Number(row.replacement_count)
  if (!Number.isSafeInteger(replacementCount) || replacementCount < 0 || replacementCount !== findings.length) return null
  if (typeof row.openmed_model_id !== 'string' || !row.openmed_model_id.trim()) return null
  if (row.openmed_model_revision != null && typeof row.openmed_model_revision !== 'string') return null
  if (row.openmed_backend != null && typeof row.openmed_backend !== 'string') return null
  if (typeof row.deidentification_method !== 'string' || typeof row.deidentification_policy !== 'string') return null
  if (typeof row.offline !== 'boolean') return null

  let createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? '')
  let createdAtTimestamp = Date.parse(createdAt)
  if (!Number.isFinite(createdAtTimestamp)) return null
  return {
    id: row.id,
    revision,
    sourceText: row.source_text,
    sourceCodepointLength: sourceCodepoints.length,
    createdAtTimestamp,
    audioCleanupDependencies,
    modelId: row.openmed_model_id,
    modelRevision: typeof row.openmed_model_revision === 'string' ? row.openmed_model_revision : null,
    backend: typeof row.openmed_backend === 'string' ? row.openmed_backend : null,
    method: row.deidentification_method,
    policy: row.deidentification_policy,
    offline: row.offline,
    replacementCount,
    createdAt,
    rerunRequired: findings.some((finding) => finding.allowedInAnalysis && !finding.appliedInAudit),
    findings,
  }
}

function newestTranscriptPrivacyAudit(
  components: readonly TranscriptPrivacyAuditComponent[],
): TranscriptPrivacyAuditComponent | null {
  return [...components].sort((left, right) =>
    right.createdAtTimestamp - left.createdAtTimestamp || right.id.localeCompare(left.id)
  )[0] ?? null
}

function publicTranscriptPrivacyFindings(
  findings: readonly TranscriptPrivacyFindingComponent[],
): ReviewTranscriptPrivacyFinding[] {
  return findings.map(({ appliedInAudit: _appliedInAudit, ...finding }) => finding)
}

type TranscriptPrivacyAuditSelection = {
  audit: ReviewTranscriptPrivacyAudit
  components: TranscriptPrivacyAuditComponent[]
}

function composeTranscriptPrivacyAudits(
  components: readonly TranscriptPrivacyAuditComponent[],
  currentTranscript: string,
): TranscriptPrivacyAuditSelection | null {
  let byRevision = new Map<number, TranscriptPrivacyAuditComponent[]>()
  for (let component of components) {
    let revisionComponents = byRevision.get(component.revision) ?? []
    revisionComponents.push(component)
    byRevision.set(component.revision, revisionComponents)
  }
  if ([...byRevision.values()].some((revisionComponents) => revisionComponents.length !== 1)) return null

  let ordered = [...components].sort((left, right) => left.revision - right.revision)
  let matchingSuffixes: TranscriptPrivacyAuditComponent[][] = []
  for (let index = 0; index < ordered.length; index++) {
    let suffix = ordered.slice(index)
    if (suffix.map((component) => component.sourceText).join('\n') === currentTranscript) {
      matchingSuffixes.push(suffix)
    }
  }
  if (matchingSuffixes.length !== 1) return null

  let suffix = matchingSuffixes[0]!
  let latest = suffix.at(-1)!
  let offset = 0
  let findings: TranscriptPrivacyFindingComponent[] = []
  for (let [componentIndex, component] of suffix.entries()) {
    for (let finding of component.findings) {
      findings.push({
        ...finding,
        ordinal: findings.length,
        startCodepoint: finding.startCodepoint + offset,
        endCodepoint: finding.endCodepoint + offset,
      })
    }
    offset += component.sourceCodepointLength
    if (componentIndex < suffix.length - 1) offset += 1
  }

  let replacementCount = suffix.reduce((total, component) => total + component.replacementCount, 0)
  if (!Number.isSafeInteger(replacementCount) || replacementCount !== findings.length) return null
  return {
    components: suffix,
    audit: {
      id: latest.id,
      modelId: latest.modelId,
      modelRevision: latest.modelRevision,
      backend: latest.backend,
      method: latest.method,
      policy: latest.policy,
      offline: suffix.every((component) => component.offline),
      replacementCount,
      createdAt: latest.createdAt,
      rerunRequired: findings.some((finding) => finding.allowedInAnalysis && !finding.appliedInAudit),
      findings: publicTranscriptPrivacyFindings(findings),
    },
  }
}

/**
 * Returns validated findings that cover the exact transcript currently shown.
 * A whole-transcript audit wins; recommencement audits are composed only when
 * their immutable source texts exactly reconstruct the transcript.
 */
async function getHandoverTranscriptPrivacyAuditSelectionForUser(
  db: Database,
  input: { handoverId: string; userId: string },
): Promise<TranscriptPrivacyAuditSelection | null> {
  let result = await db.exec(sql`
    select
      handover.transcript as current_transcript,
      audit.id,
      audit.revision,
      audit.source_text,
      audit.source_sha256,
      audit.openmed_model_id,
      audit.openmed_model_revision,
      audit.openmed_backend,
      audit.deidentification_method,
      audit.deidentification_policy,
      audit.offline,
      audit.replacement_count,
      audit.created_at,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', exception.id,
          'normalizedText', exception.normalized_text,
          'canonicalLabel', exception.canonical_label
        ) order by exception.id)
        from local_privacy_exceptions exception
        where exception.handover_family_id = coalesce(handover.source_handover_id, handover.id)
      ), '[]'::jsonb) as active_exceptions,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'jobId', dependency.cleanup_job_id,
          'revision', dependency.cleanup_revision
        ) order by dependency.cleanup_revision, dependency.cleanup_job_id)
        from local_privacy_audit_audio_cleanup_dependencies dependency
        where dependency.audit_id = audit.id
      ), '[]'::jsonb) as audio_cleanup_dependencies,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'ordinal', finding.ordinal,
          'label', finding.label,
          'entityType', finding.entity_type,
          'canonicalLabel', finding.canonical_label,
          'originalText', finding.original_text,
          'startCodepoint', finding.start_codepoint,
          'endCodepoint', finding.end_codepoint,
          'confidence', finding.confidence,
          'sources', finding.sources,
          'appliedExceptionId', (
            select applied.exception_id
            from local_privacy_audit_applied_exceptions applied
            where applied.audit_id = finding.audit_id
              and applied.finding_ordinal = finding.ordinal
          )
        ) order by finding.ordinal)
        from local_privacy_findings finding
        where finding.audit_id = audit.id
      ), '[]'::jsonb) as findings
    from handovers handover
    join local_privacy_audits audit on audit.handover_id = handover.id
    left join handover_jobs job on job.id = audit.job_id
      and job.handover_id = handover.id
      and job.revision = audit.revision
    left join analysis_runs run on run.id = audit.analysis_run_id
      and run.handover_id = handover.id
      and run.job_id = job.id
      and run.revision = audit.revision
    left join shifts shift on shift.id = handover.shift_id
    where handover.id = ${input.handoverId}
      and audit.context_type = 'handover-dspy'
      and (
        (
          audit.copied_from_audit_id is null
          and job.status = 'completed'
          and run.status = 'completed'
        )
        or (
          audit.copied_from_audit_id is not null
          and handover.source_handover_id is not null
          and audit.job_id is null
          and audit.analysis_run_id is null
        )
      )
      and (
        handover.created_by_user_id = ${input.userId}
        or jsonb_exists(handover.shared_with_user_ids, ${input.userId})
        or shift.created_by_user_id = ${input.userId}
        or jsonb_exists(shift.assigned_user_ids, ${input.userId})
        or exists (
          select 1 from handover_assignments assignment
          where assignment.handover_id = handover.id
            and assignment.assigned_to_user_id = ${input.userId}
        )
      )
    order by audit.revision asc, audit.created_at desc, audit.id desc
  `)
  let rows = result.rows ?? []
  if (rows.length === 0) return null
  let currentTranscript = rows[0]?.current_transcript
  if (typeof currentTranscript !== 'string') return null
  if (rows.some((row) => row.current_transcript !== currentTranscript)) return null

  let components = rows.map(parseTranscriptPrivacyAuditComponent)
  if (components.some((component) => component == null)) return null
  let validatedComponents = components as TranscriptPrivacyAuditComponent[]

  let exact = newestTranscriptPrivacyAudit(
    validatedComponents.filter((component) => component.sourceText === currentTranscript),
  )
  if (exact) {
    let { revision: _revision, sourceText: _sourceText, sourceCodepointLength: _sourceCodepointLength,
      createdAtTimestamp: _createdAtTimestamp, audioCleanupDependencies: _audioCleanupDependencies,
      findings, ...audit } = exact
    return {
      components: [exact],
      audit: { ...audit, findings: publicTranscriptPrivacyFindings(findings) },
    }
  }
  return composeTranscriptPrivacyAudits(validatedComponents, currentTranscript)
}

export async function getHandoverTranscriptPrivacyAuditForUser(
  db: Database,
  input: { handoverId: string; userId: string },
): Promise<ReviewTranscriptPrivacyAudit | null> {
  return (await getHandoverTranscriptPrivacyAuditSelectionForUser(db, input))?.audit ?? null
}

export type HandoverPrivacyFindingRef = {
  auditId: string
  ordinal: number
}

export type ActiveHandoverPrivacyException = {
  exceptionId: string
  normalizedText: string
  canonicalLabel: string
}

type PrivacyAuditCleanupComponent = {
  id: string
  revision: number
  sourceText: string
  createdAtTimestamp: number
  dependencies: Array<{ jobId: string; revision: number }>
}

/**
 * Worker-only provenance lookup for the exact transcript that existed before
 * an extension began. Failed analysis runs remain eligible because recording
 * deletion happens before cloud analysis, and their immutable local audit can
 * still prove which cleanup jobs contributed the stored transcript.
 */
export async function listHandoverPrivacyAudioCleanupDependenciesForTranscript(
  db: Database,
  input: { handoverId: string; transcript: string },
): Promise<Array<{ jobId: string; revision: number }>> {
  if (!input.handoverId.trim() || !input.transcript) return []
  let result = await db.exec(sql`
    select
      audit.id, audit.revision, audit.source_text, audit.source_sha256,
      audit.created_at,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'jobId', dependency.cleanup_job_id,
          'revision', dependency.cleanup_revision
        ) order by dependency.cleanup_revision, dependency.cleanup_job_id)
        from local_privacy_audit_audio_cleanup_dependencies dependency
        where dependency.audit_id = audit.id
      ), '[]'::jsonb) as dependencies
    from local_privacy_audits audit
    where audit.handover_id = ${input.handoverId}
      and audit.context_type = 'handover-dspy'
    order by audit.revision, audit.created_at, audit.id
  `)
  let components: PrivacyAuditCleanupComponent[] = []
  for (let row of result.rows ?? []) {
    if (typeof row.id !== 'string' || typeof row.source_text !== 'string') continue
    let revision = Number(row.revision)
    let createdAtTimestamp = Date.parse(row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at ?? ''))
    if (
      !Number.isSafeInteger(revision)
      || revision <= 0
      || !Number.isFinite(createdAtTimestamp)
      || row.source_sha256 !== createHash('sha256').update(row.source_text, 'utf8').digest('hex')
    ) continue
    let rawDependencies = jsonValue(row.dependencies)
    if (!Array.isArray(rawDependencies)) continue
    let dependencies: Array<{ jobId: string; revision: number }> = []
    let valid = true
    for (let value of rawDependencies) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        valid = false
        break
      }
      let dependency = value as Record<string, unknown>
      let jobId = typeof dependency.jobId === 'string' ? dependency.jobId : ''
      let cleanupRevision = Number(dependency.revision)
      if (!jobId || !Number.isSafeInteger(cleanupRevision) || cleanupRevision <= 0) {
        valid = false
        break
      }
      dependencies.push({ jobId, revision: cleanupRevision })
    }
    if (valid) components.push({
      id: row.id,
      revision,
      sourceText: row.source_text,
      createdAtTimestamp,
      dependencies,
    })
  }

  let exact = [...components]
    .filter((component) => component.sourceText === input.transcript)
    .sort((left, right) =>
      right.createdAtTimestamp - left.createdAtTimestamp || right.id.localeCompare(left.id))[0]
  let selected = exact ? [exact] : (() => {
    let byRevision = new Map<number, PrivacyAuditCleanupComponent[]>()
    for (let component of components) {
      let revisionComponents = byRevision.get(component.revision) ?? []
      revisionComponents.push(component)
      byRevision.set(component.revision, revisionComponents)
    }
    if ([...byRevision.values()].some((values) => values.length !== 1)) return []
    let ordered = [...components].sort((left, right) => left.revision - right.revision)
    let matching = ordered
      .map((_component, index) => ordered.slice(index))
      .filter((suffix) => suffix.map((component) => component.sourceText).join('\n') === input.transcript)
    return matching.length === 1 ? matching[0]! : []
  })()
  let seen = new Set<string>()
  return selected
    .flatMap((component) => component.dependencies)
    .filter((dependency) => {
      let key = JSON.stringify([dependency.jobId, dependency.revision])
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => left.revision - right.revision || left.jobId.localeCompare(right.jobId))
}

function normalizedPrivacyExceptionText(value: string): string {
  let normalized = value.normalize('NFKC')
  if (!normalized.trim() || normalized.length > 512) throw new TypeError('Privacy exception text is invalid.')
  return normalized
}

function normalizedPrivacyExceptionLabel(value: string): string {
  let normalized = value.normalize('NFKC')
  if (!normalized.trim() || normalized.length > 200) throw new TypeError('Privacy exception label is invalid.')
  return normalized
}

async function currentPrivacyAuditMapSupportsExceptions(
  db: Database,
  audit: ReviewTranscriptPrivacyAudit,
  exceptions: readonly LocalPrivacyAllowedFinding[],
): Promise<boolean> {
  let auditIds = [...new Set(audit.findings.map((finding) => finding.sourceAuditId))]
  if (auditIds.length === 0) return false
  let result = await db.exec(sql`
    select
      audit.id, audit.source_text, audit.openmed_deidentified_text,
      coalesce(jsonb_agg(jsonb_build_object(
        'ordinal', finding.ordinal,
        'originalText', finding.original_text,
        'replacementText', finding.replacement_text,
        'start', finding.start_codepoint,
        'end', finding.end_codepoint,
        'canonicalLabel', finding.canonical_label
      ) order by finding.ordinal) filter (where finding.audit_id is not null), '[]'::jsonb) as findings
    from local_privacy_audits audit
    left join local_privacy_findings finding on finding.audit_id = audit.id
    where audit.id = any(${auditIds}::text[])
    group by audit.id
  `)
  if ((result.rows?.length ?? 0) !== auditIds.length) return false
  try {
    for (let row of result.rows ?? []) {
      if (typeof row.source_text !== 'string' || typeof row.openmed_deidentified_text !== 'string') return false
      let rawFindings = jsonValue(row.findings)
      if (!Array.isArray(rawFindings)) return false
      let findings = rawFindings.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError()
        let finding = value as Record<string, unknown>
        if (
          Number(finding.ordinal) !== index
          || typeof finding.originalText !== 'string'
          || typeof finding.replacementText !== 'string'
          || !Number.isSafeInteger(finding.start)
          || !Number.isSafeInteger(finding.end)
          || (finding.canonicalLabel != null && typeof finding.canonicalLabel !== 'string')
        ) throw new TypeError()
        return {
          originalText: finding.originalText,
          replacementText: finding.replacementText,
          start: Number(finding.start),
          end: Number(finding.end),
          canonicalLabel: finding.canonicalLabel as string | null,
        }
      })
      applyLocalPrivacyExceptions(
        row.source_text,
        { text: row.openmed_deidentified_text, piiFindings: findings },
        exceptions,
      )
    }
    return true
  } catch {
    return false
  }
}

/** Loads the append-only family exceptions used by future local-first runs. */
export async function listActiveHandoverPrivacyExceptions(
  db: Database,
  handoverId: string,
): Promise<ActiveHandoverPrivacyException[]> {
  let result = await db.exec(sql`
    select exception.id, exception.normalized_text, exception.canonical_label
    from handovers handover
    join local_privacy_exceptions exception
      on exception.handover_family_id = coalesce(handover.source_handover_id, handover.id)
    where handover.id = ${handoverId}
    order by exception.created_at, exception.id
  `)
  return (result.rows ?? []).map((row) => {
    if (
      typeof row.id !== 'string'
      || typeof row.normalized_text !== 'string'
      || typeof row.canonical_label !== 'string'
    ) throw new TypeError('Stored privacy exception is invalid.')
    return {
      exceptionId: row.id,
      normalizedText: normalizedPrivacyExceptionText(row.normalized_text),
      canonicalLabel: normalizedPrivacyExceptionLabel(row.canonical_label),
    }
  })
}

export type AllowHandoverPrivacyFindingsResult = {
  outcome: 'saved'
  createdCount: number
  totalCount: number
} | {
  outcome: 'not-found' | 'stale' | 'unsupported'
}

class PrivacyFindingChangedDuringAllowError extends Error {
  constructor() {
    super('The personal-information finding changed while it was being allowed.')
    this.name = 'PrivacyFindingChangedDuringAllowError'
  }
}

/**
 * Saves one atomic, append-only decision for a group of currently displayed
 * OpenMed findings. It never queues or dispatches analysis work.
 */
export async function allowHandoverPrivacyFindingsForUser(
  db: Database,
  input: {
    handoverId: string
    userId: string
    findingRefs: readonly HandoverPrivacyFindingRef[]
  },
): Promise<AllowHandoverPrivacyFindingsResult> {
  if (input.findingRefs.length < 1 || input.findingRefs.length > 32) return { outcome: 'stale' }
  let uniqueRefs = new Map<string, HandoverPrivacyFindingRef>()
  for (let ref of input.findingRefs) {
    if (
      !ref
      || typeof ref.auditId !== 'string'
      || !ref.auditId.trim()
      || !Number.isSafeInteger(ref.ordinal)
      || ref.ordinal < 0
    ) return { outcome: 'stale' }
    uniqueRefs.set(JSON.stringify([ref.auditId, ref.ordinal]), {
      auditId: ref.auditId.trim(),
      ordinal: ref.ordinal,
    })
  }
  if (uniqueRefs.size !== input.findingRefs.length) return { outcome: 'stale' }

  try {
    return await db.transaction(async (tx) => {
      let familyRootId = await lockHandoverPrivacyFamilyForTransaction(tx, input.handoverId)
      if (!familyRootId) return { outcome: 'not-found' } as const
      let locked = await tx.exec(sql`
      select handover.id, handover.transcript
      from handovers handover
      left join shifts shift on shift.id = handover.shift_id
      where handover.id = ${input.handoverId}
        and (
          handover.created_by_user_id = ${input.userId}
          or jsonb_exists(handover.shared_with_user_ids, ${input.userId})
          or shift.created_by_user_id = ${input.userId}
          or jsonb_exists(shift.assigned_user_ids, ${input.userId})
          or exists (
            select 1 from handover_assignments assignment
            where assignment.handover_id = handover.id
              and assignment.assigned_to_user_id = ${input.userId}
          )
        )
      for update of handover
    `)
      let handover = locked.rows?.[0]
      if (!handover || typeof handover.transcript !== 'string') return { outcome: 'not-found' } as const
      let audit = await getHandoverTranscriptPrivacyAuditForUser(tx, {
        handoverId: input.handoverId,
        userId: input.userId,
      })
      if (!audit) return { outcome: 'stale' } as const

      let currentByRef = new Map(audit.findings.map((finding) => [
        JSON.stringify([finding.sourceAuditId, finding.sourceOrdinal]),
        finding,
      ]))
      let selected: Array<{ finding: ReviewTranscriptPrivacyFinding; originalText: string }> = []
      let transcriptCodepoints = [...handover.transcript]
      for (let key of uniqueRefs.keys()) {
        let finding = currentByRef.get(key)
        if (!finding) return { outcome: 'stale' } as const
        if (!finding.canonicalLabel) return { outcome: 'unsupported' } as const
        let originalText = transcriptCodepoints
          .slice(finding.startCodepoint, finding.endCodepoint)
          .join('')
        if (!originalText) return { outcome: 'stale' } as const
        selected.push({ finding, originalText })
      }

      let proposedExceptions: LocalPrivacyAllowedFinding[] = [
        ...await listActiveHandoverPrivacyExceptions(tx, input.handoverId),
      ]
      let proposedKeys = new Set(proposedExceptions.map((exception) => JSON.stringify([
        exception.normalizedText,
        exception.canonicalLabel,
      ])))
      for (let [index, { finding, originalText }] of selected.entries()) {
        let normalizedText = normalizedPrivacyExceptionText(originalText)
        let canonicalLabel = normalizedPrivacyExceptionLabel(finding.canonicalLabel!)
        let key = JSON.stringify([normalizedText, canonicalLabel])
        if (proposedKeys.has(key)) continue
        proposedKeys.add(key)
        proposedExceptions.push({
          exceptionId: `proposed-exception-${index}`,
          normalizedText,
          canonicalLabel,
        })
      }
      if (!await currentPrivacyAuditMapSupportsExceptions(tx, audit, proposedExceptions)) {
        return { outcome: 'unsupported' } as const
      }

      let createdCount = 0
      for (let { finding, originalText } of selected) {
        let normalizedText = normalizedPrivacyExceptionText(originalText)
        let canonicalLabel = normalizedPrivacyExceptionLabel(finding.canonicalLabel!)
        let inserted = await tx.exec(sql`
        insert into local_privacy_exceptions(
          id, handover_family_id, normalized_text, canonical_label,
          source_handover_id, source_audit_id, source_finding_ordinal,
          source_original_text, created_by_user_id, created_at
        )
        select
          ${`local-privacy-exception-${randomUUID()}`}, ${familyRootId},
          ${normalizedText}, ${canonicalLabel}, ${input.handoverId},
          finding.audit_id, finding.ordinal, finding.original_text,
          ${input.userId}, now()
        from local_privacy_findings finding
        join local_privacy_audits audit on audit.id = finding.audit_id
        join handovers source on source.id = audit.handover_id
        where finding.audit_id = ${finding.sourceAuditId}
          and finding.ordinal = ${finding.sourceOrdinal}
          and finding.original_text = ${originalText}
          and finding.canonical_label = ${finding.canonicalLabel}
          and coalesce(source.source_handover_id, source.id) = ${familyRootId}
        on conflict (handover_family_id, normalized_text, canonical_label) do nothing
        returning id
      `)
        if ((inserted.rows?.length ?? 0) === 1) {
          createdCount++
          continue
        }
        // `ON CONFLICT DO NOTHING` is the only legitimate zero-row outcome.
        // If the source finding disappeared or changed after the read model was
        // built, abort the whole batch so earlier decisions do not partially
        // commit under a stale UI action.
        let existing = await tx.exec(sql`
          select id from local_privacy_exceptions
          where handover_family_id = ${familyRootId}
            and normalized_text = ${normalizedText}
            and canonical_label = ${canonicalLabel}
          limit 1
        `)
        if (!existing.rows?.[0]) throw new PrivacyFindingChangedDuringAllowError()
      }
      return { outcome: 'saved', createdCount, totalCount: selected.length } as const
    })
  } catch (error) {
    if (error instanceof PrivacyFindingChangedDuringAllowError) return { outcome: 'stale' }
    throw error
  }
}

/** Queues a full, analysis-only revision only while an unapplied exception is visible. */
export async function queueHandoverPrivacyReanalysisForUser(
  db: Database,
  input: { handoverId: string; userId: string; jobId: string },
): Promise<'queued' | 'not-found' | 'not-required' | 'busy' | 'cleanup-unproven'> {
  if (!input.jobId.trim()) throw new TypeError('Reanalysis job identifier is required.')
  class CleanupUnprovenError extends Error {}
  try {
    return await db.transaction(async (tx) => {
    let familyRootId = await lockHandoverPrivacyFamilyForTransaction(tx, input.handoverId)
    if (!familyRootId) return 'not-found'
    let handover = await lockAccessibleHandoverForReview(tx, {
      id: input.handoverId,
      userId: input.userId,
    })
    if (!handover) return 'not-found'
    if (handover.processing_status !== 'completed') return 'busy'
    if (!handover.transcript.trim() || handover.transcription_metadata == null) return 'not-required'
    let auditSelection = await getHandoverTranscriptPrivacyAuditSelectionForUser(tx, {
      handoverId: input.handoverId,
      userId: input.userId,
    })
    if (!auditSelection?.audit.rerunRequired) return 'not-required'

    let dependencyKeys = new Set<string>()
    let audioCleanupDependencies = auditSelection.components
      .flatMap((component) => component.audioCleanupDependencies)
      .filter((dependency) => {
        let key = JSON.stringify([dependency.jobId, dependency.revision])
        if (dependencyKeys.has(key)) return false
        dependencyKeys.add(key)
        return true
      })
      .sort((left, right) => left.revision - right.revision || left.jobId.localeCompare(right.jobId))
    let transcriptionMetadata = objectValue(handover.transcription_metadata)
    if (audioCleanupDependencies.length === 0 && transcriptionMetadata?.engine !== 'manual-entry') {
      throw new CleanupUnprovenError()
    }
    for (let dependency of audioCleanupDependencies) {
      let required = await requireSuccessfulTranscriptionAudioCleanupInTransaction(tx, {
        cleanupJobId: dependency.jobId,
        revision: dependency.revision,
      })
      if (!required) throw new CleanupUnprovenError()
    }

    let revision = handover.version + 1
    if (!Number.isSafeInteger(revision) || revision <= 1) {
      throw new RangeError('The next handover revision is invalid.')
    }
    let active = await tx.exec(sql`
      select id from handover_jobs
      where handover_id = ${input.handoverId} and status in ('queued', 'running')
      limit 1
    `)
    if (active.rows?.[0]) return 'busy'

    // Any exception-enabled run is local-first. Tighten every extant family
    // member under the family advisory lock before making the job visible.
    await tx.exec(sql`
      update handovers set privacy_mode_floor = 'local-first', updated_at = now()
      where id = ${familyRootId} or source_handover_id = ${familyRootId}
    `)
    let payload = {
      retryFrom: 'analysis' as const,
      privacyMode: 'local-first' as const,
      privacyPolicyVersion: currentPrivacyPolicyVersion,
      ...(audioCleanupDependencies.length ? { audioCleanupDependencies } : {
        // This exact stored transcript has durable manual-entry provenance and
        // therefore never had a source recording to delete.
        manualTranscript: handover.transcript,
      }),
    }
    let inserted = await tx.exec(sql`
      insert into handover_jobs(
        id, handover_id, revision, kind, status, attempts, payload,
        created_at, updated_at
      ) values (
        ${input.jobId}, ${input.handoverId}, ${revision}, 'create', 'queued', 0,
        ${JSON.stringify(payload)}::jsonb, now(), now()
      )
      returning id
    `)
    if (!inserted.rows?.[0]) throw new Error('The reanalysis job was not queued.')
    let updated = await tx.exec(sql`
      update handovers set
        current_job_id = ${input.jobId}, version = ${revision},
        processing_status = 'queued', processing_started_at = now(),
        processing_lease_until = null, error_message = null, updated_at = now()
      where id = ${input.handoverId} and version = ${handover.version}
        and processing_status = 'completed'
      returning id
    `)
    if (!updated.rows?.[0]) throw new Error('The handover changed while reanalysis was queued.')
    await notifyHandoverJobQueued(tx, input.jobId)
    await notifyHandoverProcessingChanged(tx, input.handoverId)
    return 'queued'
    })
  } catch (error) {
    if (error instanceof CleanupUnprovenError) return 'cleanup-unproven'
    throw error
  }
}

export async function listShiftsForUser(db: Database, userId: string): Promise<ShiftRow[]> {
  let result = await db.exec(sql`
    select * from shifts
    where created_by_user_id = ${userId} or jsonb_exists(assigned_user_ids, ${userId})
    order by updated_at desc
  `)
  return ((result.rows ?? []) as ShiftRow[]).map(shiftRow)
}

export async function getShiftForUser(db: Database, id: string, userId: string): Promise<ShiftRow | null> {
  let result = await db.exec(sql`
    select * from shifts where id = ${id}
      and (created_by_user_id = ${userId} or jsonb_exists(assigned_user_ids, ${userId})) limit 1
  `)
  let row = result.rows?.[0] as ShiftRow | undefined
  return row ? shiftRow(row) : null
}

/** Inbox assignments are actionable only until the recipient adds or places them. */
export async function listPendingAssignmentsForUser(db: Database, userId: string) {
  return db.findMany(handoverAssignments, {
    where: { assigned_to_user_id: userId, status: 'pending' },
    orderBy: ['updated_at', 'desc'],
  })
}

export async function listTasksForUser(db: Database, userId: string): Promise<HandoverTaskRow[]> {
  let result = await db.exec(sql`
    select distinct t.* from handover_tasks t
    join handovers h on h.id = t.handover_id
    left join shifts s on s.id = h.shift_id
    where h.created_by_user_id = ${userId}
      or jsonb_exists(h.shared_with_user_ids, ${userId})
      or s.created_by_user_id = ${userId}
      or jsonb_exists(s.assigned_user_ids, ${userId})
      or exists (select 1 from handover_assignments a where a.handover_id = h.id and a.assigned_to_user_id = ${userId})
    order by t.updated_at desc
  `)
  return (result.rows ?? []) as HandoverTaskRow[]
}

export async function setTaskStatus(db: Database, input: { id: string; userId: string; status: HandoverTaskStatus }) {
  return db.transaction(async (tx) => {
    let task = await lockAccessibleTaskForMutation(tx, input)
    if (!task) return null
    let updated = await tx.exec(sql`
      update handover_tasks set status = ${input.status}, updated_at = now()
      where id = ${task.id} and handover_id = ${task.handover_id}
      returning *
    `)
    return (updated.rows?.[0] as HandoverTaskRow | undefined) ?? null
  })
}

/** Updates only user-editable task fields after authorizing against the task's stored handover. */
export async function updateTaskFields(db: Database, input: {
  id: string
  userId: string
  title?: string
  dueLabel?: string
  dueAt?: Date | null
  status?: HandoverTaskStatus
  reminderEnabled?: boolean
}) {
  return db.transaction(async (tx) => {
    let task = await lockAccessibleTaskForMutation(tx, input)
    if (!task) return null
    let changes: Partial<HandoverTaskRow> = { updated_at: new Date() }
    if (input.title !== undefined) changes.title = input.title
    if (input.dueLabel !== undefined) changes.due_label = input.dueLabel
    if (input.dueAt !== undefined) changes.due_at = input.dueAt
    if (input.status !== undefined) changes.status = input.status
    if (input.reminderEnabled !== undefined) changes.reminder_enabled = input.reminderEnabled
    return tx.update(handoverTasks, task.id, changes)
  })
}

export async function createShift(db: Database, input: Omit<ShiftRow, 'created_at' | 'updated_at'>) {
  let now = new Date()
  return shiftRow(await db.create(shifts, { ...input, created_at: now, updated_at: now }, { returnRow: true }))
}

export async function createHandover(
  db: Database,
  input: Omit<HandoverRow, 'created_at' | 'updated_at' | 'privacy_mode_floor'>
    & Partial<Pick<HandoverRow, 'privacy_mode_floor'>>,
) {
  let now = new Date()
  return handoverRow(await db.create(handovers, {
    ...input,
    privacy_mode_floor: input.privacy_mode_floor ?? 'cloud',
    created_at: now,
    updated_at: now,
  }, { returnRow: true }))
}

export type HandoverRecordingUploadIntent = {
  recordingUploadId: string
  userId: string
  kind: 'create' | 'extend'
  targetHandoverId: string | null
  requestFingerprint: string
}

export type HandoverRecordingUploadReplay = {
  handover: HandoverRow
  jobId: string
}

export class HandoverRecordingUploadConflictError extends Error {
  status = 409
  constructor() {
    super('This recording upload identifier has already been used for a different handover request.')
  }
}

export class HandoverRecordingUploadGoneError extends Error {
  status = 410
  constructor(message = 'The result for this recording upload is no longer available.') {
    super(message)
  }
}

/** Serialize one authenticated upload key for the lifetime of its transaction. */
export async function lockHandoverRecordingUpload(db: Database, input: Pick<HandoverRecordingUploadIntent, 'recordingUploadId' | 'userId'>) {
  await db.exec(sql`
    select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.userId, input.recordingUploadId])}, 0))
  `)
}

/**
 * Resolve an already-committed upload without trusting the UUID alone.
 * A mismatch is a conflict rather than a cache hit, and an inaccessible result
 * is never treated as a fresh mutation (which could enqueue duplicate work).
 */
export async function resolveHandoverRecordingUpload(
  db: Database,
  input: HandoverRecordingUploadIntent,
): Promise<HandoverRecordingUploadReplay | null> {
  let record = await db.findOne(handoverRecordingUploads, {
    where: { user_id: input.userId, recording_upload_id: input.recordingUploadId },
  })
  if (!record) return null
  if (
    record.kind !== input.kind
    || record.target_handover_id !== input.targetHandoverId
    || record.request_fingerprint !== input.requestFingerprint
  ) {
    throw new HandoverRecordingUploadConflictError()
  }
  let handover = await getHandoverForUser(db, record.handover_id, input.userId)
  if (!handover) throw new HandoverRecordingUploadGoneError()
  let job = await db.find(handoverJobs, record.job_id)
  if (!job || (objectValue(job.payload)?.discardedAt != null)) {
    throw new HandoverRecordingUploadGoneError('This recording upload was discarded.')
  }
  return { handover, jobId: record.job_id }
}

/** Record the result in the same transaction that creates the handover job. */
export async function recordHandoverRecordingUpload(db: Database, input: HandoverRecordingUploadIntent & {
  handoverId: string
  jobId: string
}): Promise<void> {
  if (
    (input.kind === 'create' && input.targetHandoverId !== null)
    || (input.kind === 'extend' && input.targetHandoverId !== input.handoverId)
  ) {
    throw new TypeError('Recording upload intent does not match its handover result.')
  }
  await db.create(handoverRecordingUploads, {
    user_id: input.userId,
    recording_upload_id: input.recordingUploadId,
    kind: input.kind,
    target_handover_id: input.targetHandoverId,
    handover_id: input.handoverId,
    job_id: input.jobId,
    request_fingerprint: input.requestFingerprint,
    created_at: new Date(),
  } satisfies HandoverRecordingUploadRow)
}

function patientKey(name: string, location: string): string {
  return `${name}-${location}`.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120) || randomUUID()
}

function hasPersistentSheetReview(field: HandoverSheetPatientField): boolean {
  return field.humanReviewedValue != null
    || Boolean(field.reviewedAt || field.reviewedByUserId || field.reviewEvents?.length || field.sbarUpdateEvents?.length)
}

export function mergeReviewedHandoverSheetFields(
  incoming: HandoverSheetPatientField[],
  existing: unknown,
): HandoverSheetPatientField[] {
  let current = normalizeStoredHandoverSheetFields(existing)
  return incoming.map((field) => {
    let prior = current.find((candidate) => candidate.columnKey === field.columnKey)
    if (!prior || !hasPersistentSheetReview(prior)) return field
    let hasAcceptedValue = prior.finalAcceptedValue != null || prior.humanReviewedValue != null
    return {
      ...field,
      value: hasAcceptedValue ? currentSheetFieldValue(prior) : field.value,
      reviewStatus: prior.reviewStatus,
      reviewMethod: prior.reviewMethod,
      uncertain: prior.uncertain,
      issues: [...new Set([...(field.issues ?? []), ...(prior.issues ?? [])])].slice(0, 12),
      imageQualityIssues: [...new Set([...(field.imageQualityIssues ?? []), ...(prior.imageQualityIssues ?? [])])].slice(0, 12),
      alternatives: [...new Set([...(field.alternatives ?? []), ...(prior.alternatives ?? [])])].slice(0, 6),
      llmAdjudicatedValue: prior.llmAdjudicatedValue !== undefined ? prior.llmAdjudicatedValue : field.llmAdjudicatedValue,
      llmUncertain: prior.llmUncertain !== undefined ? prior.llmUncertain : field.llmUncertain,
      llmIssue: prior.llmIssue !== undefined ? prior.llmIssue : field.llmIssue,
      humanReviewedValue: prior.humanReviewedValue !== undefined ? prior.humanReviewedValue : field.humanReviewedValue,
      finalAcceptedValue: prior.finalAcceptedValue !== undefined ? prior.finalAcceptedValue : field.finalAcceptedValue,
      reviewedAt: prior.reviewedAt !== undefined ? prior.reviewedAt : field.reviewedAt,
      reviewedByUserId: prior.reviewedByUserId !== undefined ? prior.reviewedByUserId : field.reviewedByUserId,
      reviewDecision: prior.reviewDecision ?? field.reviewDecision,
      reviewEvents: prior.reviewEvents?.length ? prior.reviewEvents : field.reviewEvents,
      sbarUpdateEvents: prior.sbarUpdateEvents?.length ? prior.sbarUpdateEvents : field.sbarUpdateEvents,
    }
  })
}

export async function importShiftHandoverSheet(db: Database, input: {
  shiftId: string; userId: string; extraction: HandoverSheetExtraction
}): Promise<{ imported: number; patientKeys: string[] } | null> {
  return db.transaction(async (tx) => {
    let shiftResult = await tx.exec(sql`
      select * from shifts where id=${input.shiftId}
        and (created_by_user_id=${input.userId} or jsonb_exists(assigned_user_ids, ${input.userId}))
      for update
    `)
    let rawShift = shiftResult.rows?.[0] as ShiftRow | undefined
    if (!rawShift) return null
    let shift = shiftRow(rawShift)
    let existingResult = await tx.exec(sql`
      select * from shift_sheet_patients
      where shift_id=${input.shiftId}
      order by patient_key
      for update
    `)
    let existing = (existingResult.rows ?? []) as ShiftSheetPatientRow[]
    let keys: string[] = []
    for (let [index, patient] of input.extraction.patients.entries()) {
      let key = patientKey(patient.displayName, patient.location)
      let prior = existing.find((row) => row.patient_key === key)
      let fields = mergeReviewedHandoverSheetFields(patient.fields, prior?.fields)
      let reviewedName = fields.find((item) => item.columnKey === 'name')
      let reviewedBed = fields.find((item) => item.columnKey === 'bed')
      let displayName = String(reviewedName?.finalAcceptedValue ?? reviewedName?.humanReviewedValue ?? patient.displayName).trim().slice(0, 240) || patient.displayName.slice(0, 240)
      let location = String(reviewedBed?.finalAcceptedValue ?? reviewedBed?.humanReviewedValue ?? patient.location).trim().slice(0, 120) || patient.location.slice(0, 120)
      // Keep filename/type/size as provenance, but never publish a durable
      // object reference for the request-scoped original document.
      await tx.exec(sql`
        insert into shift_sheet_patients (
          id, shift_id, patient_key, display_name, location, fields, raw_text, source_file_name,
          source_file_key, source_file_content_type, source_file_size_bytes, extraction_method, row_index,
          imported_by_user_id, imported_at, updated_at
        ) values (
          ${prior?.id ?? randomUUID()}, ${input.shiftId}, ${key}, ${displayName}, ${location}, ${JSON.stringify(fields)}::jsonb,
          ${patient.rawText}, ${input.extraction.fileName}, ${null}, ${input.extraction.contentType},
          ${input.extraction.sourceFileSizeBytes}, ${input.extraction.method}, ${index}, ${input.userId}, now(), now()
        ) on conflict (shift_id, patient_key) do update set
          display_name=excluded.display_name, location=excluded.location, fields=excluded.fields, raw_text=excluded.raw_text,
          source_file_name=excluded.source_file_name, source_file_key=excluded.source_file_key,
          source_file_content_type=excluded.source_file_content_type, source_file_size_bytes=excluded.source_file_size_bytes,
          extraction_method=excluded.extraction_method, row_index=excluded.row_index,
          imported_by_user_id=excluded.imported_by_user_id, updated_at=now()
      `)
      keys.push(key)
    }
    await tx.exec(sql`
      delete from shift_sheet_patients where shift_id = ${input.shiftId}
        and not (patient_key = any(${keys}::text[]))
    `)
    let order = [...shift.patient_order.filter((key) => keys.includes(key)), ...keys.filter((key) => !shift.patient_order.includes(key))]
    await tx.exec(sql`update shifts set patient_order=${JSON.stringify(order)}::jsonb, updated_at=now() where id=${input.shiftId}`)
    return { imported: keys.length, patientKeys: keys }
  })
}

export async function reviewShiftSheetPatientField(db: Database, input: {
  shiftId: string
  patientKey: string
  columnKey: string
  value: string
  userId: string
  decision?: HandoverSheetReviewDecision
}) {
  if (!(await getShiftForUser(db, input.shiftId, input.userId))) return null
  if (!handoverSheetColumns.includes(input.columnKey as HandoverSheetColumnKey)) {
    throw new Error('Unknown handover sheet field.')
  }
  let columnKey = input.columnKey as HandoverSheetColumnKey

  return db.transaction(async (tx) => {
    let sheetResult = await tx.exec(sql`
      select * from shift_sheet_patients
      where shift_id=${input.shiftId} and patient_key=${input.patientKey}
      for update
    `)
    let row = sheetResult.rows?.[0] as ShiftSheetPatientRow | undefined
    if (row) {
      let next = reviewedPatientWorksheetFields(
        normalizeStoredHandoverSheetFields(row.fields),
        columnKey,
        input.value,
        input.userId,
        input.decision,
      )
      let accepted = acceptedPatientWorksheetValue(next, columnKey)
      let displayName = columnKey === 'name' ? accepted.slice(0, 240) || row.display_name : row.display_name
      let location = columnKey === 'bed' ? accepted.slice(0, 120) || row.location : row.location
      let result = await tx.exec(sql`
        update shift_sheet_patients set fields=${JSON.stringify(next)}::jsonb,
          display_name=${displayName}, location=${location}, updated_at=now()
        where id=${row.id} returning *
      `)
      return result.rows?.[0] as ShiftSheetPatientRow
    }

    // A handover-backed patient still has a worksheet in the UI even when no
    // sheet was imported. Persist those reviews with every related handover so
    // the shift-level patient workspace remains stable across route changes.
    let candidates = await tx.exec(sql`
      select h.id, h.analysis, h.linked_patient_key,
        h.linked_patient_display_name, h.linked_patient_location
      from handovers h
      where h.shift_id=${input.shiftId}
      order by h.updated_at desc
      for update of h
    `)
    let candidateHandovers = (candidates.rows ?? []) as Array<{
      id: string
      analysis: unknown
      linked_patient_key: string | null
      linked_patient_display_name: string | null
      linked_patient_location: string | null
    }>
    let clinicalResult = candidateHandovers.length
      ? await tx.exec(sql`
          select p.id, p.handover_id, p.patient_key, p.display_name, p.location
          from handover_patients p
          where p.handover_id = any(${candidateHandovers.map((handover) => handover.id)}::text[])
          for update of p
        `)
      : { rows: [] }
    let clinicalPatients = (clinicalResult.rows ?? []) as Array<{
      id: string
      handover_id: string
      patient_key: string
      display_name: string
      location: string
    }>
    let matchedClinicalPatients = resolvePatientIdentityReferences(
      clinicalPatients.map((patient) => ({
        value: patient,
        key: patient.patient_key,
        displayName: patient.display_name,
        location: patient.location,
      })),
      input.patientKey,
    ).map((reference) => reference.value)
    let matchedLinkedHandovers = resolvePatientIdentityReferences(
      candidateHandovers.flatMap((handover) => handover.linked_patient_key ? [{
        value: handover,
        key: handover.linked_patient_key,
        displayName: handover.linked_patient_display_name,
        location: handover.linked_patient_location,
      }] : []),
      input.patientKey,
    ).map((reference) => reference.value)
    let relatedIds = new Set([
      ...matchedClinicalPatients.map((patient) => patient.handover_id),
      ...matchedLinkedHandovers.map((handover) => handover.id),
    ])
    let relatedHandovers = candidateHandovers.filter((handover) => relatedIds.has(handover.id))
    if (!relatedHandovers.length) return null

    let latestFields: HandoverSheetPatientField[] = []
    for (let handover of relatedHandovers) {
      let analysis = objectValue(handover.analysis) ?? {}
      let collection = objectValue(analysis.patientWorksheetFields) ?? {}
      let identityReferences = [
        ...clinicalPatients.filter((patient) => patient.handover_id === handover.id).map((patient) => ({
          key: patient.patient_key,
          displayName: patient.display_name,
          location: patient.location,
        })),
        ...(handover.linked_patient_key ? [{
          key: handover.linked_patient_key,
          displayName: handover.linked_patient_display_name,
          location: handover.linked_patient_location,
        }] : []),
        ...objectArray(analysis.patients).map((patient) => ({
          key: typeof patient.patientKey === 'string' ? patient.patientKey : '',
          displayName: typeof patient.displayName === 'string' ? patient.displayName : '',
          location: typeof patient.location === 'string' ? patient.location : '',
        })),
      ]
      let safeAliases = safePlaceholderPatientAliasKeys(identityReferences, input.patientKey)
      let inputKey = normalizePatientKey(input.patientKey)
      let aliasFields = Object.entries(collection).flatMap(([key, fields]) =>
        normalizePatientKey(key) !== inputKey && safeAliases.has(normalizePatientKey(key)) ? [fields] : [],
      )
      let current = mergePatientWorksheetFields([
        ...aliasFields,
        collection[input.patientKey],
      ])
      let clinicalPatient = matchedClinicalPatients.find((patient) => patient.handover_id === handover.id)
      let linked = matchedLinkedHandovers.some((candidate) => candidate.id === handover.id)
      let fallback = columnKey === 'name'
        ? String(linked ? handover.linked_patient_display_name ?? '' : clinicalPatient?.display_name ?? '')
        : columnKey === 'bed'
          ? String(linked ? handover.linked_patient_location ?? '' : clinicalPatient?.location ?? '')
          : ''
      latestFields = reviewedPatientWorksheetFields(
        current,
        columnKey,
        input.value,
        input.userId,
        input.decision,
        fallback,
      )
      let nextAnalysis = {
        ...analysis,
        patientWorksheetFields: migratePatientWorksheetFields(
          collection,
          safeAliases,
          input.patientKey,
          latestFields,
        ),
      }
      await tx.exec(sql`
        update handovers set analysis=${JSON.stringify(nextAnalysis)}::jsonb, updated_at=now()
        where id=${String(handover.id)} and shift_id=${input.shiftId}
      `)
    }

    return { patient_key: input.patientKey, fields: latestFields, source: 'handover' as const }
  })
}

function mergePatientWorksheetFields(values: unknown[]) {
  let fields = new Map<string, HandoverSheetPatientField>()
  for (let value of values) {
    for (let field of normalizeStoredHandoverSheetFields(value)) fields.set(field.columnKey, field)
  }
  return [...fields.values()]
}

function migratePatientWorksheetFields(
  collection: Record<string, unknown>,
  aliases: ReadonlySet<string>,
  patientKey: string,
  fields: HandoverSheetPatientField[],
) {
  let patientIdentityKey = normalizePatientKey(patientKey)
  let next = Object.fromEntries(Object.entries(collection).filter(([key]) => {
    let normalizedKey = normalizePatientKey(key)
    return normalizedKey === patientIdentityKey || !aliases.has(normalizedKey)
  }))
  return { ...next, [patientKey]: fields }
}

function reviewedPatientWorksheetFields(
  fields: HandoverSheetPatientField[],
  columnKey: HandoverSheetColumnKey,
  inputValue: string,
  userId: string,
  requestedDecision?: HandoverSheetReviewDecision,
  fallbackValue = '',
): HandoverSheetPatientField[] {
  let found = fields.find((candidate) => candidate.columnKey === columnKey)
  let previousValue = found
    ? found.finalAcceptedValue ?? found.humanReviewedValue ?? found.value
    : fallbackValue.trim().slice(0, 4000)
  let decision = requestedDecision ?? 'edited'
  let value = decision === 'accepted'
    ? previousValue.trim().slice(0, 4000)
    : decision === 'rejected'
      ? ''
      : inputValue.trim().slice(0, 4000)
  let at = new Date().toISOString()
  let next: HandoverSheetPatientField = {
    ...(found ?? {
      label: handoverSheetLabels[columnKey],
      columnKey,
      value: previousValue,
      reviewStatus: 'needs_review',
      reviewMethod: 'automatic',
      uncertain: true,
      issues: previousValue ? [] : ['blank'],
      templateVersion: 'ward-handover-v1',
    }),
    humanReviewedValue: value,
    finalAcceptedValue: value,
    reviewStatus: 'human_verified',
    reviewMethod: 'human',
    reviewDecision: decision,
    uncertain: false,
    reviewedAt: at,
    reviewedByUserId: userId,
    issues: (found?.issues ?? []).filter((issue) =>
      issue !== 'human_review_required'
      && issue !== 'native_llm_requires_human_review'
      && issue !== 'sbar_reconciliation_requires_human_review'),
    reviewEvents: [
      ...(found?.reviewEvents ?? []),
      { at, byUserId: userId, previousValue, nextValue: value, method: 'human' as const },
    ].slice(-20),
  }
  return found
    ? fields.map((candidate) => candidate === found ? next : candidate)
    : [...fields, next]
}

function acceptedPatientWorksheetValue(fields: HandoverSheetPatientField[], columnKey: HandoverSheetColumnKey): string {
  let field = fields.find((candidate) => candidate.columnKey === columnKey)
  return field?.finalAcceptedValue ?? field?.humanReviewedValue ?? field?.value ?? ''
}

export type StoredHandoverSheetReconciliationTarget = HandoverSheetSbarReconciliationInput & {
  shiftId: string
  sheetPatientId: string
  handoverVersion: number
  expectedValues: Record<HandoverSheetColumnKey, string>
}

function reconciliationSummary(value: unknown): AnalysisSummary | null {
  let candidate = objectValue(value)
  if (!candidate) return null
  let situation = typeof candidate.situation === 'string' ? candidate.situation.trim() : ''
  let background = typeof candidate.background === 'string' ? candidate.background.trim() : ''
  let assessment = typeof candidate.assessment === 'string' ? candidate.assessment.trim() : ''
  let recommendation = typeof candidate.recommendation === 'string' ? candidate.recommendation.trim() : ''
  return situation && background && assessment && recommendation
    ? { situation, background, assessment, recommendation }
    : null
}

function reconciliationEvidence(value: unknown): DspySpan[] {
  return objectArray(value).flatMap((candidate): DspySpan[] => {
    let label = typeof candidate.label === 'string' ? candidate.label.trim() : ''
    let quote = typeof candidate.quote === 'string' ? candidate.quote.trim() : ''
    return label && quote ? [{ label, quote }] : []
  }).slice(0, 12)
}

function reconciliationMatchKey(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

type ReconciliationCandidate = {
  patientKey: string
  displayName: string
  location: string
  structuredSummary: AnalysisSummary
}

function reconciliationCandidates(handover: HandoverRow, analysis: Record<string, unknown>): ReconciliationCandidate[] {
  let globalSummary = reconciliationSummary(analysis.structuredSummary)
  let patients = objectArray(analysis.patients)
  let linkedPatientKey = handover.linked_patient_key?.trim() ?? ''
  if (linkedPatientKey && globalSummary) {
    let linked = patients.find((candidate) => reconciliationMatchKey(String(candidate.patientKey ?? '')) === reconciliationMatchKey(linkedPatientKey))
    return [{
      patientKey: linkedPatientKey,
      displayName: handover.linked_patient_display_name?.trim()
        || (typeof linked?.displayName === 'string' ? linked.displayName.trim() : '')
        || linkedPatientKey,
      location: handover.linked_patient_location?.trim()
        || (typeof linked?.location === 'string' ? linked.location.trim() : ''),
      structuredSummary: globalSummary,
    }]
  }
  return patients.flatMap((patient): ReconciliationCandidate[] => {
    let patientKey = typeof patient.patientKey === 'string' ? patient.patientKey.trim() : ''
    let displayName = typeof patient.displayName === 'string' ? patient.displayName.trim() : ''
    let location = typeof patient.location === 'string' ? patient.location.trim() : ''
    let summary = patients.length === 1 ? globalSummary : reconciliationSummary(patient.summary)
    return patientKey && displayName && summary
      ? [{ patientKey, displayName, location, structuredSummary: summary }]
      : []
  })
}

function findReconciliationSheetRow(rows: ShiftSheetPatientRow[], candidate: ReconciliationCandidate): ShiftSheetPatientRow | null {
  let patientKey = reconciliationMatchKey(candidate.patientKey)
  let direct = rows.find((row) => reconciliationMatchKey(row.patient_key) === patientKey)
  if (direct) return direct
  let name = reconciliationMatchKey(candidate.displayName)
  let nameMatches = rows.filter((row) => reconciliationMatchKey(row.display_name) === name)
  if (!nameMatches.length) return null
  let location = reconciliationMatchKey(candidate.location)
  if (location) return nameMatches.find((row) => reconciliationMatchKey(row.location) === location) ?? null
  return nameMatches.length === 1 ? nameMatches[0]! : null
}

function currentSheetFieldValue(field: HandoverSheetPatientField | undefined): string {
  return (field?.finalAcceptedValue ?? field?.humanReviewedValue ?? field?.value ?? '').trim()
}

/**
 * Loads immutable prompts for the completed handover revision. No model call
 * runs while a database transaction or row lock is open.
 */
export async function listStoredHandoverSheetReconciliationTargets(
  db: Database,
  handoverId: string,
): Promise<StoredHandoverSheetReconciliationTarget[]> {
  let rawHandover = await db.find(handovers, handoverId)
  if (!rawHandover) return []
  let handover = handoverRow(rawHandover)
  if (handover.processing_status !== 'completed') return []
  let shiftId = handover.shift_id ?? handover.source_shift_id
  let analysis = objectValue(handover.analysis)
  if (!shiftId || !analysis) return []
  let rows = await db.findMany(shiftSheetPatients, { where: { shift_id: shiftId }, orderBy: ['row_index', 'asc'] })
  if (!rows.length) return []
  let usedRows = new Set<string>()
  let sbarEvidence = reconciliationEvidence(analysis.sbarEvidence)
  let handoverTitle = handover.context_type === 'shift-handover'
    ? handover.title
    : typeof analysis.titleSuggestion === 'string' && analysis.titleSuggestion.trim()
      ? analysis.titleSuggestion.trim()
      : handover.title
  return reconciliationCandidates(handover, analysis).flatMap((candidate): StoredHandoverSheetReconciliationTarget[] => {
    let row = findReconciliationSheetRow(rows, candidate)
    if (!row || usedRows.has(row.id)) return []
    usedRows.add(row.id)
    let sheetFields = normalizeStoredHandoverSheetFields(row.fields)
    let expectedValues = Object.fromEntries(handoverSheetColumns.map((column) => [
      column,
      currentSheetFieldValue(sheetFields.find((field) => field.columnKey === column)),
    ])) as Record<HandoverSheetColumnKey, string>
    return [{
      shiftId,
      sheetPatientId: row.id,
      handoverVersion: handover.version,
      handoverId: handover.id,
      handoverTitle: handoverTitle.slice(0, 120),
      patient: {
        patientKey: row.patient_key,
        displayName: row.display_name,
        location: row.location,
      },
      sheetFields,
      structuredSummary: candidate.structuredSummary,
      sbarEvidence,
      expectedValues,
    }]
  })
}

function sameReconciliationValue(left: string, right: string): boolean {
  return left.toLowerCase().replace(/\s+/g, ' ').trim() === right.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function applyHandoverSheetSbarChanges(input: {
  fields: unknown
  displayName: string
  location: string
  expectedValues: Partial<Record<HandoverSheetColumnKey, string>>
  changes: HandoverSheetSbarReconciliationChange[]
  at: string
  handoverId: string
  handoverTitle: string
}): { fields: HandoverSheetPatientField[]; displayName: string; location: string; changedColumns: HandoverSheetColumnKey[] } {
  let fields = normalizeStoredHandoverSheetFields(input.fields)
  let displayName = input.displayName
  let location = input.location
  let changedColumns: HandoverSheetColumnKey[] = []
  for (let change of input.changes) {
    let index = fields.findIndex((field) => field.columnKey === change.columnKey)
    let existing = index >= 0 ? fields[index]! : undefined
    let previousValue = currentSheetFieldValue(existing)
    let expectedValue = input.expectedValues[change.columnKey]
    if (expectedValue !== undefined && !sameReconciliationValue(previousValue, expectedValue)) continue
    let nextValue = change.nextValue.trim().slice(0, 4_000)
    if (!nextValue || sameReconciliationValue(previousValue, nextValue)) continue
    let duplicate = existing?.sbarUpdateEvents?.some((event) =>
      event.handoverId === input.handoverId && sameReconciliationValue(event.nextValue, nextValue),
    )
    if (duplicate) continue
    let base: HandoverSheetPatientField = existing ?? {
      label: handoverSheetLabels[change.columnKey],
      columnKey: change.columnKey,
      value: '',
      reviewStatus: 'needs_review',
      reviewMethod: 'llm',
      uncertain: true,
      issues: [],
    }
    let issues = new Set(base.issues ?? [])
    issues.delete('blank')
    issues.add('sbar_reconciliation_requires_human_review')
    let next: HandoverSheetPatientField = {
      ...base,
      label: handoverSheetLabels[change.columnKey],
      columnKey: change.columnKey,
      value: nextValue,
      llmAdjudicatedValue: nextValue,
      llmUncertain: false,
      llmIssue: null,
      finalAcceptedValue: nextValue,
      reviewStatus: 'needs_review',
      reviewMethod: 'llm',
      reviewDecision: undefined,
      uncertain: true,
      reviewedAt: null,
      reviewedByUserId: null,
      issues: [...issues].slice(0, 12),
      reviewEvents: [...(base.reviewEvents ?? []), {
        at: input.at,
        byUserId: 'system:sbar-reconciliation',
        previousValue,
        nextValue,
        method: 'llm' as const,
      }].slice(-20),
      sbarUpdateEvents: [...(base.sbarUpdateEvents ?? []), {
        at: input.at,
        handoverId: input.handoverId,
        handoverTitle: input.handoverTitle.slice(0, 120),
        sbarSection: change.sbarSection,
        previousValue,
        nextValue,
        summaryQuote: change.summaryQuote.trim().slice(0, 500),
        rationale: change.rationale.trim().slice(0, 500),
      }].slice(-20),
    }
    if (index >= 0) fields[index] = next
    else fields.push(next)
    if (change.columnKey === 'name') displayName = nextValue.slice(0, 240) || displayName
    if (change.columnKey === 'bed') location = nextValue.slice(0, 120) || location
    changedColumns.push(change.columnKey)
  }
  return { fields, displayName, location, changedColumns }
}

/** Applies model changes to the latest locked row and skips stale fields. */
export async function persistHandoverSheetSbarChanges(db: Database, input: {
  target: StoredHandoverSheetReconciliationTarget
  changes: HandoverSheetSbarReconciliationChange[]
  at?: Date
}): Promise<number> {
  if (!input.changes.length) return 0
  return db.transaction(async (tx) => {
    let currentHandover = await tx.exec(sql`
      select id from handovers
      where id=${input.target.handoverId} and version=${input.target.handoverVersion}
        and processing_status='completed'
      for update
    `)
    if (!currentHandover.rows?.[0]) return 0
    let currentRow = await tx.exec(sql`
      select * from shift_sheet_patients
      where id=${input.target.sheetPatientId} and shift_id=${input.target.shiftId}
      for update
    `)
    let row = currentRow.rows?.[0] as ShiftSheetPatientRow | undefined
    if (!row) return 0
    let applied = applyHandoverSheetSbarChanges({
      fields: row.fields,
      displayName: row.display_name,
      location: row.location,
      expectedValues: input.target.expectedValues,
      changes: input.changes,
      at: (input.at ?? new Date()).toISOString(),
      handoverId: input.target.handoverId,
      handoverTitle: input.target.handoverTitle,
    })
    if (!applied.changedColumns.length) return 0
    await tx.exec(sql`
      update shift_sheet_patients set
        fields=${JSON.stringify(applied.fields)}::jsonb,
        display_name=${applied.displayName},
        location=${applied.location},
        updated_at=now()
      where id=${row.id}
    `)
    return applied.changedColumns.length
  })
}

export type DeleteShiftResult = {
  orphanedAudioKeys: string[]
}

/**
 * Deletes a clinician-owned shift and the authoritative handovers that belong
 * only to it. Recipient copies and handovers that still belong to another
 * source/primary shift are detached from the deleted shift instead.
 *
 * Authorization, handover deletion/detachment, and shift deletion share one
 * transaction. In particular, an assigned (but non-owning) clinician must not
 * be able to detach handovers before the ownership check fails.
 */
export async function deleteShift(db: Database, input: { id: string; userId: string }): Promise<DeleteShiftResult | null> {
  return db.transaction(async (tx) => {
    let ownershipPreview = await tx.exec(sql`
      select id from shifts
      where id = ${input.id} and created_by_user_id = ${input.userId}
    `)
    if (!ownershipPreview.rows?.[0]) return null

    let familyPreview = await tx.exec(sql`
      select id, coalesce(source_handover_id, id) as family_root_id
      from handovers
      where shift_id = ${input.id} or source_shift_id = ${input.id}
    `)
    let familyRepresentatives = new Map<string, string>()
    for (let row of familyPreview.rows ?? []) {
      if (typeof row.id === 'string' && typeof row.family_root_id === 'string') {
        familyRepresentatives.set(row.family_root_id, row.id)
      }
    }
    let lockedFamilyRoots = new Set<string>()
    for (let [expectedRootId, representativeId] of [...familyRepresentatives.entries()]
      .sort(([left], [right]) => left.localeCompare(right))) {
      let lockedRootId = await lockHandoverPrivacyFamilyForTransaction(tx, representativeId)
      if (lockedRootId !== expectedRootId) {
        throw new Error('Handover privacy family changed while the shift was deleted.')
      }
      lockedFamilyRoots.add(lockedRootId)
    }

    // Family locks precede the shift row lock. Assignment creation takes the
    // same family lock before its recipient insert takes a shift FK key-share
    // lock, so the opposite order here would permit a lock-order deadlock.
    let owned = await tx.exec(sql`
      select id from shifts
      where id = ${input.id} and created_by_user_id = ${input.userId}
      for update
    `)
    if (!owned.rows?.[0]) return null

    let related = await tx.exec(sql`
      select id, source_handover_id, coalesce(source_handover_id, id) as family_root_id,
        shift_id, source_shift_id, audio_blob_key
      from handovers
      where shift_id = ${input.id} or source_shift_id = ${input.id}
      for update
    `)
    let relatedHandovers = (related.rows ?? []) as Array<{
      id: string
      source_handover_id: string | null
      family_root_id: string
      shift_id: string | null
      source_shift_id: string | null
      audio_blob_key: string | null
    }>
    if (relatedHandovers.some((handover) => !lockedFamilyRoots.has(handover.family_root_id))) {
      throw new Error('A handover was added while the shift was being deleted. Try again.')
    }
    let deletedHandovers = relatedHandovers.filter((handover) => {
      let isPrimaryShift = handover.shift_id === input.id
      let isSourceShift = handover.source_shift_id === input.id
      return handover.source_handover_id == null && (
        (isPrimaryShift && isSourceShift)
        || (isPrimaryShift && handover.source_shift_id == null)
        || (isSourceShift && handover.shift_id == null)
      )
    })
    let deletedIds = deletedHandovers.map((handover) => handover.id)
    let preservedIds = relatedHandovers
      .filter((handover) => !deletedIds.includes(handover.id))
      .map((handover) => handover.id)
    let audioCandidates = new Set(
      deletedHandovers.map((handover) => handover.audio_blob_key?.trim() ?? '').filter(Boolean),
    )

    if (deletedIds.length) {
      let audioRows = await tx.exec(sql`
        select distinct blob_key from handover_audio
        where handover_id = any(${deletedIds}::text[])
      `)
      for (let row of audioRows.rows ?? []) {
        let key = String(row.blob_key ?? '').trim()
        if (key) audioCandidates.add(key)
      }
      await tx.exec(sql`delete from handovers where id = any(${deletedIds}::text[])`)
      for (let familyRootId of [...new Set(deletedHandovers.map((handover) => handover.family_root_id))]) {
        await deletePrivacyExceptionsForEmptyHandoverFamilyInTransaction(tx, familyRootId)
      }
    }

    if (preservedIds.length) {
      await tx.exec(sql`
        update handovers set
          shift_id = case when shift_id = ${input.id} then null else shift_id end,
          source_shift_id = case when source_shift_id = ${input.id} then null else source_shift_id end,
          updated_at = now()
        where id = any(${preservedIds}::text[])
      `)
    }

    let deletedShift = await tx.exec(sql`
      delete from shifts
      where id = ${input.id} and created_by_user_id = ${input.userId}
      returning id
    `)
    if (!deletedShift.rows?.[0]) throw new Error('Owned shift disappeared during deletion.')

    let orphanedAudioKeys = await scheduleOrphanedAudioCleanupInTransaction(tx, {
      handoverId: input.id,
      cleanupJobId: `${EXPLICIT_AUDIO_DELETION_JOB_PREFIX}shift:${input.id}`,
      revision: 1,
      candidates: audioCandidates,
    })

    return { orphanedAudioKeys }
  })
}

export async function setShiftPatientOrder(db: Database, input: { id: string; userId: string; patientOrder: string[] }): Promise<ShiftRow | null> {
  let result = await db.exec(sql`
    update shifts set patient_order = ${JSON.stringify(input.patientOrder)}::jsonb, updated_at = now()
    where id = ${input.id} and (created_by_user_id = ${input.userId} or jsonb_exists(assigned_user_ids, ${input.userId})) returning *
  `)
  let row = result.rows?.[0] as ShiftRow | undefined
  return row ? shiftRow(row) : null
}

type ReviewSummarySection = 'situation' | 'background' | 'assessment' | 'recommendation'

async function lockAccessibleHandoverForReview(db: Database, input: { id: string; userId: string }): Promise<HandoverRow | null> {
  let result = await db.exec(sql`
    select h.* from handovers h
    where h.id = ${input.id} and (
      h.created_by_user_id = ${input.userId}
      or jsonb_exists(h.shared_with_user_ids, ${input.userId})
      or exists (
        select 1 from shifts s
        where s.id = h.shift_id and (
          s.created_by_user_id = ${input.userId}
          or jsonb_exists(s.assigned_user_ids, ${input.userId})
        )
      )
      or exists (
        select 1 from handover_assignments a
        where a.handover_id = h.id and a.assigned_to_user_id = ${input.userId}
      )
    )
    for update of h
  `)
  let row = result.rows?.[0] as HandoverRow | undefined
  return row ? handoverRow(row) : null
}

async function lockAccessibleTaskForMutation(
  db: Database,
  input: { id: string; userId: string },
): Promise<HandoverTaskRow | null> {
  let candidate = await db.exec(sql`
    select handover_id from handover_tasks where id=${input.id}
  `)
  let handoverId = candidate.rows?.[0]?.handover_id
  if (typeof handoverId !== 'string') return null
  if (!await lockAccessibleHandoverForReview(db, { id: handoverId, userId: input.userId })) return null
  let locked = await db.exec(sql`
    select * from handover_tasks
    where id=${input.id} and handover_id=${handoverId}
    for update
  `)
  return (locked.rows?.[0] as HandoverTaskRow | undefined) ?? null
}

/** Atomically patches one clinician-reviewed checklist item against the latest analysis. */
export async function updateHandoverChecklistItem(db: Database, input: {
  id: string
  userId: string
  checklistItemId: string
  covered: boolean
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    let handover = await lockAccessibleHandoverForReview(tx, input)
    let analysis = handover?.analysis ? structuredClone(handover.analysis) : null
    if (!analysis || !Array.isArray(analysis.checklistFocus)) return false

    let found = false
    analysis.checklistFocus = analysis.checklistFocus.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value
      let item = value as Record<string, unknown>
      if (item.id !== input.checklistItemId) return item
      found = true
      return { ...item, status: input.covered ? 'addressed' : 'missing' }
    })
    if (!found) return false

    await tx.exec(sql`
      update handovers set analysis=${JSON.stringify(analysis)}::jsonb, updated_at=now()
      where id=${input.id}
    `)
    return true
  })
}

/** Atomically patches one SBAR section while preserving the original model draft and unrelated edits. */
export async function updateHandoverSummarySection(db: Database, input: {
  id: string
  userId: string
  section: ReviewSummarySection
  value: string
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    let handover = await lockAccessibleHandoverForReview(tx, input)
    let analysis = handover?.analysis ? structuredClone(handover.analysis) : null
    let summary = analysis ? objectValue(analysis.structuredSummary) : null
    if (!analysis || !summary) return false

    let meta = objectValue(analysis.structuredSummaryMeta) ?? {}
    let llmDraft = objectValue(meta.llmDraft) ?? structuredClone(summary)
    let previousValue = typeof summary[input.section] === 'string' ? summary[input.section] : ''
    let nextValue = input.value.trim()
    let existingEdits = Array.isArray(meta.edits) ? meta.edits : []
    analysis.structuredSummary = { ...summary, [input.section]: nextValue }
    analysis.structuredSummaryMeta = {
      ...meta,
      llmDraft,
      reviewed: false,
      edits: previousValue === nextValue ? existingEdits : [
        ...existingEdits,
        {
          section: input.section,
          previousValue,
          nextValue,
          at: new Date().toISOString(),
          byUserId: input.userId,
        },
      ].slice(-100),
    }
    await tx.exec(sql`
      update handovers set analysis=${JSON.stringify(analysis)}::jsonb, updated_at=now()
      where id=${input.id}
    `)
    return true
  })
}

/** Atomically updates SBAR review state without replacing clinician-edited sections. */
export async function updateHandoverSummaryReviewStatus(db: Database, input: {
  id: string
  userId: string
  reviewed: boolean
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    let handover = await lockAccessibleHandoverForReview(tx, input)
    let analysis = handover?.analysis ? structuredClone(handover.analysis) : null
    let summary = analysis ? objectValue(analysis.structuredSummary) : null
    if (!analysis || !summary) return false

    let meta = objectValue(analysis.structuredSummaryMeta) ?? {}
    analysis.structuredSummaryMeta = {
      ...meta,
      llmDraft: objectValue(meta.llmDraft) ?? structuredClone(summary),
      reviewed: input.reviewed,
    }
    await tx.exec(sql`
      update handovers set analysis=${JSON.stringify(analysis)}::jsonb, updated_at=now()
      where id=${input.id}
    `)
    return true
  })
}

/** Applies the review header's clinician-owned participant and patient corrections. */
export async function updateHandoverReviewMetadata(db: Database, input: {
  id: string
  userId: string
  participants: string[]
  patients: Array<{ patientKey: string; displayName: string; location: string }>
}): Promise<HandoverRow | null> {
  let participants = [...new Set(input.participants.map((value) => value.trim()).filter(Boolean))]
  let patches = new Map(input.patients.map((patient) => [patient.patientKey, {
    displayName: patient.displayName.trim(),
    location: patient.location.trim(),
  }]))

  return db.transaction(async (tx) => {
    let existing = await lockAccessibleHandoverForReview(tx, input)
    if (!existing) return null

    let analysis = existing.analysis ? structuredClone(existing.analysis) : null
    if (analysis) {
      if (Array.isArray(analysis.patients)) {
        analysis.patients = analysis.patients.map((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return value
          let patient = value as Record<string, unknown>
          let key = typeof patient.patientKey === 'string' ? patient.patientKey : ''
          let patch = patches.get(key)
          return patch ? { ...patient, ...patch } : patient
        })
      }
      analysis.participants = participants
    }

    let linkedPatch = existing.linked_patient_key ? patches.get(existing.linked_patient_key) : undefined
    let linkedPatientDisplayName = linkedPatch?.displayName ?? existing.linked_patient_display_name
    let linkedPatientLocation = linkedPatch?.location ?? existing.linked_patient_location
    let participantsEdited = existing.participants_edited === true || !sameStringList(
      storedParticipantNames(existing.participants),
      participants,
    )
    let title = existing.title
    if (linkedPatientDisplayName && existing.direction === 'outgoing' && /^(?:Delivering|Outgoing) handover ·/.test(title)) {
      title = `Delivering handover · ${linkedPatientDisplayName}`.slice(0, 120)
    } else if (linkedPatientDisplayName && existing.direction === 'intra-shift' && /^(?:Intra-shift|Another) handover ·/.test(title)) {
      title = `Intra-shift handover · ${linkedPatientDisplayName}`.slice(0, 120)
    }

    let updated = await tx.update(handovers, existing.id, {
      title,
      participants: participants.map((name) => ({ name })),
      participants_edited: participantsEdited,
      linked_patient_display_name: linkedPatientDisplayName,
      linked_patient_location: linkedPatientLocation,
      analysis,
      updated_at: new Date(),
    })
    for (let [patientKey, patch] of patches) await tx.exec(sql`
      update handover_patients set display_name=${patch.displayName}, location=${patch.location}
      where handover_id=${existing.id} and patient_key=${patientKey}
    `)
    return handoverRow(updated)
  })
}

export async function extendHandover(db: Database, input: {
  id: string; userId: string; jobId: string; payload?: import('./schema.ts').HandoverJobPayload;
  audio?: { id: string; key: string; contentType: string; originalFilename: string; sizeBytes: number; provisionalCleanupId?: string }
  recordingUpload?: { id: string; requestFingerprint: string }
}): Promise<{ handover: HandoverRow; replayed: boolean } | null> {
  let existing = await getHandoverForUser(db, input.id, input.userId)
  if (!existing) return null
  return db.transaction(async (tx) => {
    if (input.recordingUpload) {
      let intent: HandoverRecordingUploadIntent = {
        recordingUploadId: input.recordingUpload.id,
        userId: input.userId,
        kind: 'extend',
        targetHandoverId: input.id,
        requestFingerprint: input.recordingUpload.requestFingerprint,
      }
      await lockHandoverRecordingUpload(tx, intent)
      let replay = await resolveHandoverRecordingUpload(tx, intent)
      if (replay) {
        if (input.audio?.provisionalCleanupId) {
          await consumeProvisionalAudioUploadCleanupInTransaction(tx, {
            cleanupId: input.audio.provisionalCleanupId,
            blobKey: input.audio.key,
            userId: input.userId,
            recordingUploadId: input.recordingUpload.id,
            allowMissing: true,
          })
        }
        return { handover: replay.handover, replayed: true }
      }
    }
    if (!await lockHandoverPrivacyFamilyForTransaction(tx, input.id)) return null
    let lockedResult = await tx.exec(sql`select * from handovers where id = ${input.id} for update`)
    let locked = lockedResult.rows?.[0]
    if (!locked) return null
    if (input.audio) {
      if (input.audio.provisionalCleanupId && input.recordingUpload) {
        await consumeProvisionalAudioUploadCleanupInTransaction(tx, {
          cleanupId: input.audio.provisionalCleanupId,
          blobKey: input.audio.key,
          userId: input.userId,
          recordingUploadId: input.recordingUpload.id,
        })
      } else {
        await lockAudioBlobKeyForReferenceAssignment(tx, input.audio.key)
      }
    }
    let revisionResult = await tx.exec(sql`
      select greatest(
        ${Number(locked.version)},
        coalesce((select max(revision) from handover_jobs where handover_id = ${input.id}), 0)
      ) + 1 as next_revision
    `)
    let nextRevision = Number(revisionResult.rows?.[0]?.next_revision)
    if (!Number.isSafeInteger(nextRevision) || nextRevision <= 0) throw new Error('Unable to reserve the next handover revision.')
    if (input.audio) await tx.create(handoverAudio, {
      id: input.audio.id, handover_id: input.id, revision: nextRevision, purpose: 'extension', blob_key: input.audio.key,
      content_type: input.audio.contentType, original_filename: input.audio.originalFilename, size_bytes: input.audio.sizeBytes, created_at: new Date(),
    })
    let { enqueueHandoverJob } = await import('./queue.ts')
    await enqueueHandoverJob(tx, { id: input.jobId, handoverId: input.id, revision: nextRevision, kind: 'extend', payload: input.payload })
    if (input.recordingUpload) {
      await recordHandoverRecordingUpload(tx, {
        recordingUploadId: input.recordingUpload.id,
        userId: input.userId,
        kind: 'extend',
        targetHandoverId: input.id,
        requestFingerprint: input.recordingUpload.requestFingerprint,
        handoverId: input.id,
        jobId: input.jobId,
      })
    }
    let updatedResult = await tx.exec(sql`select * from handovers where id = ${input.id}`)
    return updatedResult.rows?.[0]
      ? { handover: handoverRow(updatedResult.rows[0] as unknown as HandoverRow), replayed: false }
      : null
  })
}

export async function attachHandoverAudio(db: Database, input: {
  id: string; handoverId: string; userId: string; revision: number; purpose: 'initial' | 'extension';
  key: string; contentType: string; originalFilename: string; sizeBytes: number
}): Promise<import('./schema.ts').HandoverAudioRow | null> {
  let handover = await getHandoverForUser(db, input.handoverId, input.userId)
  if (!handover) return null
  if (handover.version !== input.revision) throw new Error('Handover revision changed before audio attachment.')
  return db.transaction(async (tx) => {
    let locked = await tx.exec(sql`
      select id from handovers where id = ${input.handoverId} and version = ${input.revision} for update
    `)
    if (!locked.rows?.[0]) throw new Error('Handover revision changed before audio attachment.')
    await lockAudioBlobKeyForReferenceAssignment(tx, input.key)
    let row = await tx.create(handoverAudio, {
      id: input.id, handover_id: input.handoverId, revision: input.revision, purpose: input.purpose, blob_key: input.key,
      content_type: input.contentType, original_filename: input.originalFilename, size_bytes: input.sizeBytes, created_at: new Date(),
    }, { returnRow: true })
    await tx.exec(sql`
      update handovers set audio_blob_key=${input.key}, audio_content_type=${input.contentType},
        audio_original_filename=${input.originalFilename}, audio_size_bytes=${input.sizeBytes}, updated_at=now()
      where id=${input.handoverId} and version=${input.revision}
    `)
    return row
  })
}

async function scheduleOrphanedAudioCleanupInTransaction(db: Database, input: {
  handoverId: string
  cleanupJobId: string
  revision: number
  candidates: Iterable<string>
}): Promise<string[]> {
  let orphaned: string[] = []
  let candidates = [...new Set([...input.candidates].map((key) => key.trim()).filter(Boolean))].sort()
  for (let candidate of candidates) {
    let cleanup = await enqueueResourceCleanupIfEligibleInTransaction(db, {
      id: randomUUID(),
      kind: LOCAL_AUDIO_OBJECT_CLEANUP_KIND,
      resourceId: candidate,
      blobKey: candidate,
      handoverId: input.handoverId,
      jobId: input.cleanupJobId,
      revision: input.revision,
    }, async () => {
      // The enqueue helper holds the resource advisory lock across this final
      // reference check and the insert, while preserving row -> advisory order.
      let refs = await db.exec(sql`
        select exists(select 1 from handovers where audio_blob_key=${candidate})
          or exists(select 1 from handover_audio where blob_key=${candidate}) as referenced
      `)
      return !refs.rows?.[0]?.referenced
    })
    if (cleanup) orphaned.push(candidate)
  }
  return orphaned
}

/** Caller must hold the matching privacy-family advisory lock. */
async function deletePrivacyExceptionsForEmptyHandoverFamilyInTransaction(
  db: Database,
  familyRootId: string,
): Promise<void> {
  await db.exec(sql`
    delete from local_privacy_exceptions exception
    where exception.handover_family_id = ${familyRootId}
      and not exists (
        select 1 from handovers member
        where member.id = ${familyRootId}
          or member.source_handover_id = ${familyRootId}
      )
  `)
}

export async function deleteHandoverAndCollectOrphanedAudioKeys(db: Database, input: { id: string; userId: string }): Promise<string[] | null> {
  return db.transaction(async (tx) => {
    let familyRootId = await lockHandoverPrivacyFamilyForTransaction(tx, input.id)
    if (!familyRootId) return null
    let locked = await tx.exec(sql`
      select id, audio_blob_key, version from handovers
      where id=${input.id} and created_by_user_id=${input.userId}
      for update
    `)
    let handover = locked.rows?.[0] as { id: string; audio_blob_key: string | null; version: number } | undefined
    if (!handover) return null
    let candidates = await tx.exec(sql`select distinct blob_key from handover_audio where handover_id=${input.id}`)
    if (handover.audio_blob_key) candidates.rows = [...(candidates.rows ?? []), { blob_key: handover.audio_blob_key }]
    let deleted = await tx.exec(sql`
      delete from handovers where id=${input.id} and created_by_user_id=${input.userId}
      returning id
    `)
    if (!deleted.rows?.[0]) throw new Error('Owned handover disappeared during deletion.')
    await deletePrivacyExceptionsForEmptyHandoverFamilyInTransaction(tx, familyRootId)
    return scheduleOrphanedAudioCleanupInTransaction(tx, {
      handoverId: handover.id,
      cleanupJobId: `${EXPLICIT_AUDIO_DELETION_JOB_PREFIX}handover:${handover.id}`,
      revision: Number.isSafeInteger(Number(handover.version)) && Number(handover.version) > 0 ? Number(handover.version) : 1,
      candidates: (candidates.rows ?? []).map((row) => String(row.blob_key ?? '')),
    })
  })
}

export type DiscardFailedHandoverAttemptResult = {
  outcome: 'restored' | 'deleted'
  discardedRevision: number
} | {
  outcome: 'unsafe'
  reason: string
}

/**
 * Discards only the active failed processing attempt. A failed extension is
 * rolled back to the last completed revision and its clinical payload/audio
 * references are removed. A failed full privacy reanalysis is also restored
 * to its earlier completed revision even though its immutable job kind is
 * `create`. An initial failure has no earlier handover state to restore, so
 * discarding it removes the empty handover shell as before.
 */
export async function discardFailedHandoverAttempt(db: Database, input: {
  id: string
  userId: string
}): Promise<DiscardFailedHandoverAttemptResult | null> {
  return db.transaction(async (tx) => {
    let familyRootId = await lockHandoverPrivacyFamilyForTransaction(tx, input.id)
    if (!familyRootId) return null
    let locked = await tx.exec(sql`
      select h.* from handovers h
      left join shifts s on s.id = h.shift_id
      where h.id=${input.id} and h.processing_status='failed' and (
        h.created_by_user_id=${input.userId} or jsonb_exists(h.shared_with_user_ids, ${input.userId})
        or s.created_by_user_id=${input.userId} or jsonb_exists(s.assigned_user_ids, ${input.userId})
        or exists (
          select 1 from handover_assignments a
          where a.handover_id=h.id and a.assigned_to_user_id=${input.userId}
        )
      )
      for update of h
    `)
    let handover = locked.rows?.[0]
    if (!handover || typeof handover.current_job_id !== 'string') return null

    let failedResult = await tx.exec(sql`
      select * from handover_jobs
      where id=${handover.current_job_id} and handover_id=${input.id} and status='failed'
      for update
    `)
    let failed = failedResult.rows?.[0]
    if (!failed) return null
    let failedRevision = Number(failed.revision)
    let payload = objectValue(failed.payload) ?? {}
    let localFirstHistory = handover.privacy_mode_floor === 'local-first'
      || payload.privacyMode === 'local-first'
    if (localFirstHistory) {
      await ratchetHandoverPrivacyFamily(tx, { handoverId: input.id })
    }
    let previousResult = await tx.exec(sql`
      select id, revision from handover_jobs
      where handover_id=${input.id} and status='completed' and revision < ${failedRevision}
      order by revision desc, completed_at desc nulls last, created_at desc
      limit 1
      for update
    `)
    let previous = previousResult.rows?.[0]

    if (!previous) {
      let candidates = await tx.exec(sql`select distinct blob_key from handover_audio where handover_id=${input.id}`)
      if (handover.audio_blob_key) candidates.rows = [...(candidates.rows ?? []), { blob_key: handover.audio_blob_key }]
      let deleted = await tx.exec(sql`
        delete from handovers where id=${input.id} and created_by_user_id=${input.userId}
        returning id
      `)
      if (!deleted.rows?.[0]) throw new Error('Owned handover disappeared while discarding its failed attempt.')
      await deletePrivacyExceptionsForEmptyHandoverFamilyInTransaction(tx, familyRootId)
      await scheduleOrphanedAudioCleanupInTransaction(tx, {
        handoverId: input.id,
        cleanupJobId: String(failed.id),
        revision: failedRevision,
        candidates: (candidates.rows ?? []).map((row) => String(row.blob_key ?? '')),
      })
      return { outcome: 'deleted', discardedRevision: failedRevision }
    }

    let rollbackTranscript = String(handover.transcript ?? '')
    let rollbackMetadata = objectValue(handover.transcription_metadata)
    if (Object.prototype.hasOwnProperty.call(payload, 'rollbackTranscript')) {
      if (typeof payload.rollbackTranscript !== 'string') {
        return { outcome: 'unsafe', reason: 'The saved rollback transcript is invalid.' }
      }
      rollbackTranscript = payload.rollbackTranscript
      rollbackMetadata = objectValue(payload.rollbackTranscriptionMetadata)
    } else if (payload.retryFrom === 'analysis' && failed.kind !== 'create') {
      let segmentCount = Number(payload.retrySegmentCount)
      if (!rollbackMetadata || !Number.isSafeInteger(segmentCount) || segmentCount <= 0) {
        return { outcome: 'unsafe', reason: 'The previous transcript could not be restored safely.' }
      }
      try {
        let restored = removeTranscriptionTail({
          transcript: rollbackTranscript,
          metadata: rollbackMetadata as unknown as TranscriptionMetadata,
        }, segmentCount)
        rollbackTranscript = restored.transcript
        rollbackMetadata = restored.metadata as unknown as Record<string, unknown>
      } catch {
        return { outcome: 'unsafe', reason: 'The previous transcript could not be restored safely.' }
      }
    }

    let audioCandidates = await tx.exec(sql`
      select distinct blob_key from handover_audio
      where handover_id=${input.id} and revision=${failedRevision}
      union
      select distinct nullif(btrim(payload ->> 'audioBlobKey'), '') as blob_key
      from handover_jobs
      where handover_id=${input.id} and revision=${failedRevision} and status='failed'
    `)
    await tx.exec(sql`
      delete from handover_audio where handover_id=${input.id} and revision=${failedRevision}
    `)
    let discardedAt = new Date().toISOString()
    let discardedPayload = localFirstHistory
      ? {
          discardedAt,
          privacyMode: 'local-first' as const,
          privacyPolicyVersion: currentPrivacyPolicyVersion,
        }
      : { discardedAt }
    await tx.exec(sql`
      update handover_jobs set
        payload=${JSON.stringify(discardedPayload)}::jsonb,
        error_message='Discarded by clinician.', updated_at=now()
      where handover_id=${input.id} and revision=${failedRevision} and status='failed'
    `)

    let nextResult = await tx.exec(sql`
      select id, revision, created_at from handover_jobs
      where handover_id=${input.id} and status='queued'
      order by revision asc, created_at asc
      limit 1
      for update
    `)
    let next = nextResult.rows?.[0]
    let restored = await tx.exec(sql`
      update handovers set
        transcript=${rollbackTranscript},
        transcription_metadata=${rollbackMetadata == null ? null : JSON.stringify(rollbackMetadata)}::jsonb,
        current_job_id=${next ? String(next.id) : String(previous.id)},
        version=${next ? Number(next.revision) : Number(previous.revision)},
        processing_status=${next ? 'queued' : 'completed'},
        processing_started_at=${next ? next.created_at as Date : null},
        processing_lease_until=null, error_message=null, updated_at=now()
      where id=${input.id} and current_job_id=${String(failed.id)} and processing_status='failed'
      returning id
    `)
    if (!restored.rows?.[0]) throw new Error('Failed handover state changed while discarding its attempt.')

    await scheduleOrphanedAudioCleanupInTransaction(tx, {
      handoverId: input.id,
      cleanupJobId: String(failed.id),
      revision: failedRevision,
      candidates: (audioCandidates.rows ?? []).map((row) => String(row.blob_key ?? '')),
    })
    if (next) await notifyHandoverJobQueued(tx, String(next.id))
    await notifyHandoverProcessingChanged(tx, input.id)
    return { outcome: 'restored', discardedRevision: failedRevision }
  })
}

export async function listShiftSheetPatientsForUser(db: Database, input: { shiftId: string; userId: string }) {
  let result = await db.exec(sql`
    select p.* from shift_sheet_patients p
    join shifts s on s.id = p.shift_id
    where p.shift_id = ${input.shiftId}
      and (s.created_by_user_id = ${input.userId} or jsonb_exists(s.assigned_user_ids, ${input.userId}))
    order by p.row_index asc
  `)
  return (result.rows ?? []) as ShiftSheetPatientRow[]
}

/** Batch equivalent of listShiftSheetPatientsForUser for shell projections. */
export async function listAccessibleShiftSheetPatientsForUser(db: Database, userId: string): Promise<ShiftSheetPatientRow[]> {
  let result = await db.exec(sql`
    select p.* from shift_sheet_patients p
    join shifts s on s.id = p.shift_id
    where s.created_by_user_id = ${userId} or jsonb_exists(s.assigned_user_ids, ${userId})
    order by p.shift_id asc, p.row_index asc
  `)
  return (result.rows ?? []) as ShiftSheetPatientRow[]
}

/** Collect before replacing/deleting shift sheet rows; storage remains caller-owned. */
export async function collectShiftSheetSourceFileKeys(db: Database, input: { shiftId: string; userId: string }): Promise<string[] | null> {
  if (!(await getShiftForUser(db, input.shiftId, input.userId))) return null
  let result = await db.exec(sql`
    select distinct source_file_key from shift_sheet_patients
    where shift_id=${input.shiftId} and source_file_key is not null and btrim(source_file_key) <> ''
    order by source_file_key
  `)
  return (result.rows ?? []).map((row) => String(row.source_file_key))
}

/**
 * Call after the database mutation. Only returned keys are safe candidates for
 * deletion from the configured sheet UploadStorage.
 */
export async function findUnreferencedShiftSheetSourceFileKeys(db: Database, keys: readonly string[]): Promise<string[]> {
  let candidates = [...new Set(keys.map((key) => key.trim()).filter(Boolean))]
  if (!candidates.length) return []
  let referenced = await db.exec(sql`
    select distinct source_file_key from shift_sheet_patients
    where source_file_key = any(${candidates}::text[])
  `)
  let referencedSet = new Set((referenced.rows ?? []).map((row) => String(row.source_file_key)))
  return candidates.filter((key) => !referencedSet.has(key))
}

export async function createAssignment(db: Database, input: {
  id: string; handoverId: string; assignedByUserId: string; assignedToUserId: string; targetShiftId?: string | null
}) {
  if (input.assignedByUserId === input.assignedToUserId) throw new Error('Choose a different clinician to receive this handover.')
  let accessible = await getHandoverForUser(db, input.handoverId, input.assignedByUserId)
  if (!accessible) return null
  if (!(await getUser(db, input.assignedToUserId))) throw new Error('The selected clinician could not be found.')

  let copyId = randomUUID(), now = new Date()
  return db.transaction(async (tx) => {
    let privacyFamilyRootId = await lockHandoverPrivacyFamilyForTransaction(tx, accessible.id)
    if (!privacyFamilyRootId) return null
    // Retention locks the authoritative source handover before inspecting its
    // active job and blob references. Use the same source -> job order here so
    // a recipient copy cannot publish a stale blob reference after deletion.
    let locked = await tx.exec(sql`
      select h.* from handovers h where h.id=${accessible.id}
      for update of h
    `)
    let rawSource = locked.rows?.[0] as HandoverRow | undefined
    if (!rawSource) return null
    let source = handoverRow(rawSource)

    let activeJob: HandoverJobRow | null = null
    if (
      source.current_job_id
      && ['queued', 'transcribing', 'analysing'].includes(source.processing_status)
    ) {
      let current = await tx.exec(sql`
        select * from handover_jobs
        where id=${source.current_job_id} and handover_id=${source.id}
          and status in ('queued','running')
        for update
      `)
      activeJob = (current.rows?.[0] as HandoverJobRow | undefined) ?? null
    }

    let sourceId = source.source_handover_id ?? source.id
    if (sourceId !== privacyFamilyRootId) {
      throw new Error('Handover privacy family changed while the assignment was created.')
    }
    await tx.exec(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`handover-assignment:${sourceId}:${input.assignedToUserId}`}, 0)
      )
    `)
    let existing = await tx.exec(sql`
      select a.* from handover_assignments a join handovers h on h.id=a.handover_id
      where h.source_handover_id=${sourceId} and a.assigned_to_user_id=${input.assignedToUserId}
      order by a.updated_at desc limit 1
    `)
    if (existing.rows?.[0]) return existing.rows[0] as import('./schema.ts').HandoverAssignmentRow

    // Transaction-bound pg clients execute serially; avoid concurrent query calls
    // on the same client (pg 9 removes that deprecated behavior).
    let active = activeJob !== null
    let copyNeedsAudio = activeJob !== null && activeJob.payload.retryFrom !== 'analysis'
    let copiedJobPayload = activeJob ? { ...activeJob.payload } : null
    let copyPrivacyModeFloor = source.privacy_mode_floor === 'local-first' ? 'local-first' : 'cloud'
    if (copiedJobPayload && copyPrivacyModeFloor === 'local-first') {
      copiedJobPayload.privacyMode = 'local-first'
    }
    if (copiedJobPayload && !copyNeedsAudio) {
      delete copiedJobPayload.audioBlobKey
      delete copiedJobPayload.audioOriginalFilename
    }
    let tasks = await tx.findMany(handoverTasks, { where: { handover_id: source.id } })
    let patients = await tx.findMany(handoverPatients, { where: { handover_id: source.id } })
    let bookmarks = await tx.findMany(handoverBookmarks, { where: { handover_id: source.id } })
    // A completed recipient copy needs the durable transcript/review, not the
    // sender's raw audio. Copy audio only while cloning the exact active job
    // that still needs it for transcription.
    let audioRows = copyNeedsAudio
      ? await tx.findMany(handoverAudio, { where: { handover_id: source.id } })
      : []
    let activeJobAudioKey = typeof activeJob?.payload.audioBlobKey === 'string'
      ? activeJob.payload.audioBlobKey.trim()
      : ''
    let copiedAudioKeys = [...new Set([
      copyNeedsAudio ? source.audio_blob_key?.trim() ?? '' : '',
      copyNeedsAudio ? activeJobAudioKey : '',
      ...audioRows.map((row) => row.blob_key.trim()),
    ].filter(Boolean))].sort()
    for (let key of copiedAudioKeys) await lockAudioBlobKeyForReferenceAssignment(tx, key)
    let taskIds = new Map(tasks.map((task) => [task.id, randomUUID()]))
    let analysis = remapRecipientAnalysis(source.analysis, taskIds)
    let copiedJobId = active ? randomUUID() : null
    await tx.exec(sql`
      insert into handovers (
        id, created_by_user_id, source_handover_id, privacy_mode_floor, shift_id, source_shift_id, title, direction,
        source_department, destination_department, context_type, linked_patient_key, linked_patient_display_name,
        linked_patient_location, participants, participants_edited, shared_with_user_ids, consent_mode, priority_preference, notes,
        audio_blob_key, audio_content_type, audio_original_filename, audio_size_bytes, transcript,
        transcription_metadata, analysis, processing_status, processing_started_at, error_message, version,
        current_job_id, processing_lease_until, created_at, updated_at
      ) select
        ${copyId}, ${input.assignedToUserId}, ${sourceId}, ${copyPrivacyModeFloor}, null, coalesce(source_shift_id, shift_id), title, direction,
        source_department, destination_department, context_type, linked_patient_key, linked_patient_display_name,
        linked_patient_location, participants, participants_edited, '[]'::jsonb, consent_mode, priority_preference, notes,
        ${copyNeedsAudio ? source.audio_blob_key : null}, ${copyNeedsAudio ? source.audio_content_type : null},
        ${copyNeedsAudio ? source.audio_original_filename : null}, ${copyNeedsAudio ? source.audio_size_bytes : null}, transcript,
        transcription_metadata, ${JSON.stringify(analysis)}::jsonb, ${active ? 'queued' : source.processing_status},
        ${active ? now : null}, ${active ? null : source.error_message}, version, ${copiedJobId}, null, ${now}, ${now}
      from handovers where id=${source.id}
    `)
    await copyCompletedHandoverPrivacyAuditsInTransaction(tx, {
      sourceHandoverId: source.id,
      recipientHandoverId: copyId,
    })
    for (let row of audioRows) await tx.exec(sql`
      insert into handover_audio(id,handover_id,revision,purpose,blob_key,content_type,original_filename,size_bytes,created_at)
      values(${randomUUID()},${copyId},${row.revision},${row.purpose},${row.blob_key},${row.content_type},${row.original_filename},${row.size_bytes},${now})
    `)
    for (let row of patients) await tx.exec(sql`
      insert into handover_patients(id,handover_id,patient_key,display_name,location,acuity_score,risk_score,workflow_score,priority_reason,created_at)
      values(${randomUUID()},${copyId},${row.patient_key},${row.display_name},${row.location},${row.acuity_score},${row.risk_score},${row.workflow_score},${row.priority_reason},${now})
    `)
    for (let row of tasks) await tx.exec(sql`
      insert into handover_tasks(id,handover_id,patient_key,title,due_label,due_at,priority,status,reminder_enabled,carried_forward,source,related_uncertainty_id,created_at,updated_at)
      values(${taskIds.get(row.id)!},${copyId},${row.patient_key},${row.title},${row.due_label},${row.due_at},${row.priority},${row.status},${row.reminder_enabled},${row.carried_forward},${row.source},${row.related_uncertainty_id},${now},${now})
    `)
    for (let row of bookmarks) await tx.exec(sql`
      insert into handover_bookmarks(id,handover_id,patient_key,label,revisit_reason,segment_id,likely_query_context,status,created_at,updated_at)
      values(${randomUUID()},${copyId},${row.patient_key},${row.label},${row.revisit_reason},${row.segment_id},${row.likely_query_context},${row.status},${now},${now})
    `)
    if (copiedJobId && activeJob) {
      await tx.exec(sql`
        insert into handover_jobs(id,handover_id,revision,kind,status,attempts,payload,created_at,updated_at)
        values(${copiedJobId},${copyId},${activeJob.revision},${activeJob.kind},'queued',0,${JSON.stringify(copiedJobPayload)}::jsonb,${now},${now})
      `)
      await notifyHandoverJobQueued(tx, copiedJobId)
    }
    return tx.create(handoverAssignments, {
      id: input.id, handover_id: copyId, assigned_by_user_id: input.assignedByUserId,
      assigned_to_user_id: input.assignedToUserId, target_shift_id: input.targetShiftId ?? null,
      status: 'pending', assigned_at: now, placed_at: null, updated_at: now,
    }, { returnRow: true })
  })
}

async function copyCompletedHandoverPrivacyAuditsInTransaction(
  tx: Database,
  input: { sourceHandoverId: string; recipientHandoverId: string },
): Promise<void> {
  let auditIdPrefix = `recipient-audit:${input.recipientHandoverId}:`
  let requestIdPrefix = `recipient-request:${input.recipientHandoverId}:`

  await tx.exec(sql`
    insert into local_privacy_audits(
      id, context_type, handover_id, shift_id, job_id, analysis_run_id,
      revision, initiated_by_user_id, source_text, source_sha256,
      source_utf8_bytes, deidentified_text, deidentified_sha256,
      deidentified_utf8_bytes, openmed_model_id, openmed_model_revision,
      openmed_deidentified_text, openmed_deidentified_sha256,
      openmed_deidentified_utf8_bytes, applied_exception_count,
      openmed_sdk_version, openmed_backend, deidentification_method,
      deidentification_policy, offline, smart_merging, safety_sweep,
      replacement_count, created_at, copied_from_audit_id
    )
    select
      ${auditIdPrefix} || coalesce(audit.copied_from_audit_id, audit.id),
      audit.context_type, ${input.recipientHandoverId},
      null, null, null, audit.revision, audit.initiated_by_user_id,
      audit.source_text, audit.source_sha256, audit.source_utf8_bytes,
      audit.deidentified_text, audit.deidentified_sha256,
      audit.deidentified_utf8_bytes, audit.openmed_model_id,
      audit.openmed_model_revision, audit.openmed_deidentified_text,
      audit.openmed_deidentified_sha256, audit.openmed_deidentified_utf8_bytes,
      audit.applied_exception_count, audit.openmed_sdk_version,
      audit.openmed_backend, audit.deidentification_method,
      audit.deidentification_policy, audit.offline, audit.smart_merging,
      audit.safety_sweep, audit.replacement_count, audit.created_at,
      coalesce(audit.copied_from_audit_id, audit.id)
    from local_privacy_audits audit
    join handovers source on source.id = audit.handover_id
    left join handover_jobs job on job.id = audit.job_id
      and job.handover_id = source.id
      and job.revision = audit.revision
    left join analysis_runs run on run.id = audit.analysis_run_id
      and run.handover_id = source.id
      and run.job_id = job.id
      and run.revision = audit.revision
    where source.id = ${input.sourceHandoverId}
      and audit.context_type = 'handover-dspy'
      and (
        (
          audit.copied_from_audit_id is null
          and job.status = 'completed'
          and run.status = 'completed'
        )
        or (
          audit.copied_from_audit_id is not null
          and source.source_handover_id is not null
          and audit.job_id is null
          and audit.analysis_run_id is null
        )
      )
  `)

  await tx.exec(sql`
    insert into local_privacy_findings(
      audit_id, ordinal, label, entity_type, canonical_label, original_text,
      replacement_text, start_codepoint, end_codepoint, confidence,
      threshold, sources, action
    )
    select
      copied.id, finding.ordinal, finding.label, finding.entity_type,
      finding.canonical_label, finding.original_text, finding.replacement_text,
      finding.start_codepoint, finding.end_codepoint, finding.confidence,
      finding.threshold, finding.sources, finding.action
    from local_privacy_findings finding
    join local_privacy_audits source_audit on source_audit.id = finding.audit_id
      and source_audit.handover_id = ${input.sourceHandoverId}
    join local_privacy_audits copied
      on copied.handover_id = ${input.recipientHandoverId}
      and copied.copied_from_audit_id = coalesce(
        source_audit.copied_from_audit_id,
        source_audit.id
      )
  `)

  await tx.exec(sql`
    insert into local_privacy_audit_applied_exceptions(
      audit_id, finding_ordinal, exception_id, applied_at
    )
    select copied.id, applied.finding_ordinal, applied.exception_id, applied.applied_at
    from local_privacy_audit_applied_exceptions applied
    join local_privacy_audits source_audit on source_audit.id = applied.audit_id
      and source_audit.handover_id = ${input.sourceHandoverId}
    join local_privacy_audits copied
      on copied.handover_id = ${input.recipientHandoverId}
      and copied.copied_from_audit_id = coalesce(
        source_audit.copied_from_audit_id,
        source_audit.id
      )
  `)

  await tx.exec(sql`
    insert into local_privacy_audit_audio_cleanup_dependencies(
      audit_id, cleanup_job_id, cleanup_revision
    )
    select copied.id, dependency.cleanup_job_id, dependency.cleanup_revision
    from local_privacy_audit_audio_cleanup_dependencies dependency
    join local_privacy_audits source_audit on source_audit.id = dependency.audit_id
      and source_audit.handover_id = ${input.sourceHandoverId}
    join local_privacy_audits copied
      on copied.handover_id = ${input.recipientHandoverId}
      and copied.copied_from_audit_id = coalesce(
        source_audit.copied_from_audit_id,
        source_audit.id
      )
  `)

  // These are immutable terminal evidence rows, not new dispatch attempts.
  // copied_from_request_id makes that distinction durable after the source
  // handover, job, audit, and original request rows cascade away.
  await tx.exec(sql`
    insert into local_privacy_cloud_requests(
      id, audit_id, target_kind, target_name, provider, model, status,
      error_type, prepared_at, dispatch_started_at, completed_at, failed_at,
      updated_at, copied_from_request_id
    )
    select
      ${requestIdPrefix} || coalesce(
        source_request.copied_from_request_id,
        source_request.id
      ),
      copied.id, source_request.target_kind, source_request.target_name,
      source_request.provider, source_request.model, source_request.status,
      source_request.error_type, source_request.prepared_at,
      source_request.dispatch_started_at, source_request.completed_at,
      source_request.failed_at, source_request.updated_at,
      coalesce(source_request.copied_from_request_id, source_request.id)
    from local_privacy_cloud_requests source_request
    join local_privacy_audits source_audit on source_audit.id = source_request.audit_id
      and source_audit.handover_id = ${input.sourceHandoverId}
    join local_privacy_audits copied
      on copied.handover_id = ${input.recipientHandoverId}
      and copied.copied_from_audit_id = coalesce(
        source_audit.copied_from_audit_id,
        source_audit.id
      )
    where source_request.status in ('completed', 'failed')
    on conflict do nothing
  `)

}

function remapRecipientAnalysis(value: unknown, taskIds: Map<string, string>): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  let analysis = structuredClone(value) as Record<string, unknown>
  if (!Array.isArray(analysis.patients)) return analysis
  analysis.patients = analysis.patients.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    let patient = raw as Record<string, unknown>
    return {
      ...patient,
      tasks: Array.isArray(patient.tasks) ? patient.tasks.map((rawTask) => {
        if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) return rawTask
        let task = rawTask as Record<string, unknown>, old = typeof task.id === 'string' ? task.id : ''
        return { ...task, id: taskIds.get(old) ?? randomUUID() }
      }) : patient.tasks,
      uncertainties: Array.isArray(patient.uncertainties) ? patient.uncertainties.map((rawUncertainty) => {
        if (!rawUncertainty || typeof rawUncertainty !== 'object' || Array.isArray(rawUncertainty)) return rawUncertainty
        let uncertainty = rawUncertainty as Record<string, unknown>, old = typeof uncertainty.linkedTaskId === 'string' ? uncertainty.linkedTaskId : ''
        return { ...uncertainty, linkedTaskId: old ? taskIds.get(old) ?? null : null }
      }) : patient.uncertainties,
    }
  })
  return analysis
}

/** Places a recipient copy into one of the recipient's shifts. Repeating the same placement is safe. */
export async function placeAssignment(db: Database, input: {
  id: string
  userId: string
  targetShiftId: string
}) {
  if (!(await getShiftForUser(db, input.targetShiftId, input.userId))) return null
  return db.transaction(async (tx) => {
    let result = await tx.exec(sql`
      select a.*, h.source_shift_id, h.shift_id, h.shared_with_user_ids
      from handover_assignments a
      join handovers h on h.id = a.handover_id
      where a.id = ${input.id} and a.assigned_to_user_id = ${input.userId}
      for update of a, h
    `)
    let assignment = result.rows?.[0] as (import('./schema.ts').HandoverAssignmentRow & {
      source_shift_id: string | null
      shift_id: string | null
      shared_with_user_ids: unknown
    }) | undefined
    if (!assignment) return null

    let sharedWithUserIds = stringArray(assignment.shared_with_user_ids)
    if (!sharedWithUserIds.includes(input.userId)) sharedWithUserIds.push(input.userId)
    await tx.exec(sql`
      update handovers set
        shift_id = ${input.targetShiftId},
        source_shift_id = coalesce(source_shift_id, shift_id),
        shared_with_user_ids = ${JSON.stringify(sharedWithUserIds)}::jsonb,
        updated_at = now()
      where id = ${assignment.handover_id}
    `)
    return tx.update(handoverAssignments, assignment.id, {
      status: 'placed', target_shift_id: input.targetShiftId,
      placed_at: new Date(), updated_at: new Date(),
    })
  })
}

/** Adds an unplaced recipient copy to Previous handovers. Repeating the operation is safe. */
export async function addAssignmentToIndividual(db: Database, input: { id: string; userId: string }) {
  return db.transaction(async (tx) => {
    let result = await tx.exec(sql`
      select a.*, h.shared_with_user_ids
      from handover_assignments a
      join handovers h on h.id = a.handover_id
      where a.id = ${input.id} and a.assigned_to_user_id = ${input.userId}
      for update of a, h
    `)
    let assignment = result.rows?.[0] as (import('./schema.ts').HandoverAssignmentRow & {
      shared_with_user_ids: unknown
    }) | undefined
    if (!assignment || assignment.status === 'placed') return null

    let sharedWithUserIds = stringArray(assignment.shared_with_user_ids)
    if (!sharedWithUserIds.includes(input.userId)) sharedWithUserIds.push(input.userId)
    await tx.exec(sql`
      update handovers set
        shared_with_user_ids = ${JSON.stringify(sharedWithUserIds)}::jsonb,
        updated_at = now()
      where id = ${assignment.handover_id}
    `)
    return tx.update(handoverAssignments, assignment.id, {
      status: 'individual', target_shift_id: null,
      placed_at: new Date(), updated_at: new Date(),
    })
  })
}

export type DismissAssignmentResult = { orphanedAudioKeys: string[] }

/** Recipient-only dismissal, including cleanup of a recipient-owned copy and orphaned audio. */
export async function dismissAssignment(db: Database, input: {
  id: string
  userId: string
}): Promise<DismissAssignmentResult | null> {
  return db.transaction(async (tx) => {
    let preview = await tx.exec(sql`
      select handover_id from handover_assignments
      where id = ${input.id} and assigned_to_user_id = ${input.userId}
      limit 1
    `)
    let previewHandoverId = preview.rows?.[0]?.handover_id
    if (typeof previewHandoverId !== 'string') return null
    let familyRootId = await lockHandoverPrivacyFamilyForTransaction(tx, previewHandoverId)
    if (!familyRootId) return null
    let result = await tx.exec(sql`
      select a.*, h.created_by_user_id, h.source_handover_id, h.audio_blob_key, h.shared_with_user_ids
      from handover_assignments a
      join handovers h on h.id = a.handover_id
      where a.id = ${input.id}
      for update of a, h
    `)
    let assignment = result.rows?.[0] as (import('./schema.ts').HandoverAssignmentRow & {
      created_by_user_id: string | null
      source_handover_id: string | null
      audio_blob_key: string | null
      shared_with_user_ids: unknown
    }) | undefined
    if (!assignment || assignment.assigned_to_user_id !== input.userId || assignment.status === 'placed') return null

    let audioCandidates = new Set<string>()
    if (assignment.source_handover_id && assignment.created_by_user_id === input.userId) {
      if (assignment.audio_blob_key?.trim()) audioCandidates.add(assignment.audio_blob_key.trim())
      let audioRows = await tx.exec(sql`
        select distinct blob_key from handover_audio where handover_id = ${assignment.handover_id}
      `)
      for (let row of audioRows.rows ?? []) {
        let key = String(row.blob_key ?? '').trim()
        if (key) audioCandidates.add(key)
      }
      await tx.exec(sql`delete from handovers where id = ${assignment.handover_id}`)
      await deletePrivacyExceptionsForEmptyHandoverFamilyInTransaction(tx, familyRootId)
    } else {
      await tx.delete(handoverAssignments, assignment.id)
      let remaining = await tx.exec(sql`
        select 1 from handover_assignments
        where handover_id = ${assignment.handover_id} and assigned_to_user_id = ${input.userId}
        limit 1
      `)
      if (!remaining.rows?.[0]) {
        let sharedWithUserIds = stringArray(assignment.shared_with_user_ids)
          .filter((userId) => userId !== input.userId)
        await tx.exec(sql`
          update handovers set
            shared_with_user_ids = ${JSON.stringify(sharedWithUserIds)}::jsonb,
            updated_at = now()
          where id = ${assignment.handover_id}
        `)
      }
    }

    let orphanedAudioKeys = await scheduleOrphanedAudioCleanupInTransaction(tx, {
      handoverId: assignment.handover_id,
      cleanupJobId: `${EXPLICIT_AUDIO_DELETION_JOB_PREFIX}assignment:${assignment.id}`,
      revision: 1,
      candidates: audioCandidates,
    })
    return { orphanedAudioKeys }
  })
}

function analysisHasPatientUncertainty(
  analysis: unknown,
  patientKey: string,
  uncertaintyId: string,
): boolean {
  let root = objectValue(analysis)
  let expectedPatientKey = patientKey.trim()
  let expectedUncertaintyId = uncertaintyId.trim()
  if (!root || !expectedPatientKey || !expectedUncertaintyId) return false
  return objectArray(root.patients).some((patient) => {
    if (typeof patient.patientKey !== 'string' || patient.patientKey.trim() !== expectedPatientKey) return false
    return objectArray(patient.uncertainties).some(
      (uncertainty) => typeof uncertainty.id === 'string' && uncertainty.id.trim() === expectedUncertaintyId,
    )
  })
}

/** Creates a task and resolves repeated uncertainty-task submissions to the original row. */
export async function createHandoverTask(
  db: Database,
  input: HandoverTaskRow & { userId: string },
): Promise<HandoverTaskRow | null> {
  return db.transaction(async (tx) => {
    let accessible = await lockAccessibleHandoverForReview(tx, { id: input.handover_id, userId: input.userId })
    if (!accessible) return null
    let patientKey = input.patient_key.trim()
    let uncertaintyId = input.related_uncertainty_id?.trim() ?? ''
    if (
      (input.source === 'uncertainty' && !uncertaintyId)
      || (uncertaintyId && !analysisHasPatientUncertainty(accessible.analysis, patientKey, uncertaintyId))
    ) return null
    let existing = await tx.find(handoverTasks, input.id)
    if (existing) return null
    let { userId: _userId, ...inputRow } = input
    let row = {
      ...inputRow,
      patient_key: patientKey,
      related_uncertainty_id: uncertaintyId || null,
    }
    if (!uncertaintyId) return tx.create(handoverTasks, row, { returnRow: true })

    // The partial unique index is the final guard when a browser retries or
    // multiple requests race. A no-op conflict is a successful replay, so
    // return the task that already represents this uncertainty.
    let inserted = await tx.exec(sql`
      insert into handover_tasks (
        id, handover_id, patient_key, title, due_label, due_at,
        priority, status, reminder_enabled, carried_forward, source,
        related_uncertainty_id, created_at, updated_at
      ) values (
        ${row.id}, ${row.handover_id}, ${row.patient_key}, ${row.title},
        ${row.due_label}, ${row.due_at}, ${row.priority},
        ${row.status}, ${row.reminder_enabled}, ${row.carried_forward},
        ${row.source}, ${row.related_uncertainty_id}, ${row.created_at}, ${row.updated_at}
      )
      on conflict (handover_id, patient_key, related_uncertainty_id)
        where related_uncertainty_id is not null
        do nothing
      returning *
    `)
    let created = inserted.rows?.[0] as HandoverTaskRow | undefined
    if (created) return created
    return tx.findOne(handoverTasks, {
      where: {
        handover_id: row.handover_id,
        patient_key: row.patient_key,
        related_uncertainty_id: row.related_uncertainty_id,
      },
    })
  })
}

export async function deleteHandoverTask(db: Database, input: { id: string; userId: string }): Promise<boolean> {
  return db.transaction(async (tx) => {
    let task = await lockAccessibleTaskForMutation(tx, input)
    if (!task) return false
    return tx.delete(handoverTasks, task.id)
  })
}

export async function recordUsabilitySession(db: Database, input: import('./schema.ts').UsabilitySessionRow) {
  let result = await db.exec(sql`
    insert into usability_sessions (
      id, auth_session_id, user_id, started_at, last_seen_at, ended_at, entry_path,
      referrer, user_agent, device, initial_viewport, metadata
    ) values (
      ${input.id}, ${input.auth_session_id}, ${input.user_id}, ${input.started_at}, ${input.last_seen_at}, ${input.ended_at},
      ${input.entry_path}, ${input.referrer}, ${input.user_agent}, ${JSON.stringify(input.device)}::jsonb,
      ${JSON.stringify(input.initial_viewport)}::jsonb, ${JSON.stringify(input.metadata)}::jsonb
    ) on conflict (id) do update set
      auth_session_id = coalesce(excluded.auth_session_id, usability_sessions.auth_session_id),
      user_id = coalesce(excluded.user_id, usability_sessions.user_id),
      device = case
        when usability_sessions.initial_viewport = '{}'::jsonb
          and excluded.initial_viewport <> '{}'::jsonb then excluded.device
        else usability_sessions.device
      end,
      initial_viewport = case
        when usability_sessions.initial_viewport = '{}'::jsonb
          and excluded.initial_viewport <> '{}'::jsonb then excluded.initial_viewport
        else usability_sessions.initial_viewport
      end,
      last_seen_at = greatest(usability_sessions.last_seen_at, excluded.last_seen_at),
      ended_at = coalesce(excluded.ended_at, usability_sessions.ended_at)
    returning *
  `)
  return result.rows![0] as import('./schema.ts').UsabilitySessionRow
}

export async function endUsabilitySession(db: Database, id: string, endedAt = new Date()) {
  return db.exec(sql`
    update usability_sessions
    set ended_at = coalesce(ended_at, ${endedAt}),
        last_seen_at = greatest(last_seen_at, ${endedAt})
    where id = ${id}
  `)
}

export async function recordUsabilityEvents(db: Database, events: import('./schema.ts').UsabilityEventRow[]) {
  if (!events.length) return { affectedRows: 0 }
  // Duplicate sequence numbers are expected when the browser retries a batch.
  let affected = 0
  for (let event of events) {
    let result = await db.exec(sql`
      insert into usability_events (
        id, usability_session_id, auth_session_id, user_id, event_type, event_sequence,
        occurred_at, received_at, route, path, page_title, duration_ms, viewport, target, metrics, properties, payload
      ) values (
        ${event.id}, ${event.usability_session_id}, ${event.auth_session_id}, ${event.user_id}, ${event.event_type}, ${event.event_sequence},
        ${event.occurred_at}, ${event.received_at}, ${event.route}, ${event.path}, ${event.page_title}, ${event.duration_ms},
        ${JSON.stringify(event.viewport)}::jsonb, ${JSON.stringify(event.target)}::jsonb, ${JSON.stringify(event.metrics)}::jsonb,
        ${JSON.stringify(event.properties)}::jsonb, ${JSON.stringify(event.payload)}::jsonb
      ) on conflict (usability_session_id, event_sequence) do nothing returning id
    `)
    affected += result.rows?.length ?? 0
  }
  return { affectedRows: affected }
}

export async function purgeExpiredUsabilityAnalytics(db: Database, before: Date) {
  return db.transaction(async (tx) => {
    let events = await tx.exec(sql`delete from usability_events where received_at < ${before}`)
    let sessions = await tx.exec(sql`
      delete from usability_sessions where last_seen_at < ${before}
        and not exists (select 1 from usability_events event where event.usability_session_id = usability_sessions.id)
    `)
    return { events: events.affectedRows ?? events.rows?.length ?? 0, sessions: sessions.affectedRows ?? sessions.rows?.length ?? 0 }
  })
}
