import 'dotenv/config'

import { randomUUID } from 'node:crypto'

import { sql, type Database } from 'remix/data-table'

import {
  acquireHandoverJobLease,
  appendTranscriptToExisting,
  attachAudioNoiseMetrics,
  claimNextHandoverJob,
  clearHandoverJobLease,
  completeHandoverJob,
  createHandoverJobQueueWakeup,
  notifyHandoverProcessingChanged,
  createConfiguredAudioStorage,
  createAudioNoiseAnalyzer,
  createDataRuntime,
  createEmptyAudioNoiseMetrics,
  createSuccessfulTranscriptionAudioRetention,
  currentPrivacyPolicyVersion,
  isLocalFirstAudioStorageBackendCompatible,
  createTranscriptionService,
  failHandoverJob,
  isSuccessfulTranscriptionAudioDeletionConfirmed,
  listActiveHandoverPrivacyExceptions,
  listHandoverPrivacyAudioCleanupDependenciesForTranscript,
  normalizePrivacyMode,
  ratchetHandoverPrivacyFamily,
  refreshHandoverJobLease,
  releaseWorkerLeases,
  resolveLocalFirstProcessingPolicy,
  scheduleSuccessfulTranscriptionAudioCleanupInTransaction,
  sliceTranscriptionTail,
  type DataRuntime,
  type AudioNoiseAnalyzer,
  type HandoverJobRow,
  type HandoverJobPayload,
  type PrivacyMode,
  type TranscriptionMetadata,
  type TranscriptionResult,
  type TranscriptionService,
  type SuccessfulTranscriptionAudioRetention,
} from './app/data/index.ts'
import { isPlaceholderPatientKey } from './app/data/patient-identity.ts'
import {
  analyzeHandover,
  createConfiguredOpenAIAnalysisRequester,
  type AnalysisRequester,
  type HandoverAnalysisResult,
  type PatientProjection,
  type PersistedHandoverAnalysis,
  type TaskProjection,
} from './app/domain/handover-analysis.server.ts'
import {
  mergeHandoverContinuation,
  preserveCreateReviewMetadata,
  preserveExtensionReviewMetadata,
} from './app/domain/handover-continuation.server.ts'
import {
  createConfiguredOpenAIHandoverSheetReconciliationRequester,
  reconcileStoredHandoverSheetWithSbar,
  type HandoverSheetReconciliationRequester,
} from './app/domain/handover-sheet-reconciliation.server.ts'
import {
  createDeidentifiedAnalysisRequester,
  createDeidentifiedSheetReconciliationRequester,
  createLocalPrivacyClient,
  applyLocalPrivacyExceptionsFailClosed,
  isProtectedLocalPrivacyDenyTermLabel,
  maximumLocalPrivacyDenyTerms,
  normalizeLocalPrivacyDenyTerms,
  type LocalPrivacyDenyTerm,
  type LocalPrivacyAllowedFinding,
  type LocalPrivacyClient,
} from './app/domain/local-privacy.server.ts'
import {
  createLocalPrivacyAuditSink,
  type LocalPrivacyAuditSink,
} from './app/domain/local-privacy-audit.server.ts'

export type WorkerOptions = {
  workerId?: string
  lockMs?: number
  pollMs?: number
  dspyBaseUrl?: string
  dspySharedSecret?: string
  dspyTimeoutMs?: number
}

type Environment = Readonly<Record<string, string | undefined>>

type WorkerServices = {
  transcription: TranscriptionService
  localPrivacy: LocalPrivacyClient
  audioNoise: AudioNoiseAnalyzer
  audioRetention: SuccessfulTranscriptionAudioRetention
  analysisRequester: AnalysisRequester
  sheetReconciliationRequester: HandoverSheetReconciliationRequester
}

type ProcessingStage = 'queue' | 'transcription' | 'analysis'

export type ProcessingFailureDiagnostic = {
  stage: ProcessingStage
  errorType: string
  errorCode: string
  requestName?: string
  constraint?: string
  issues?: Array<{ code: string; path: string }>
}

type HandoverWork = {
  id: string
  title: string
  direction: string
  sourceDepartment: string
  destinationDepartment: string
  contextType: string
  linkedPatientKey: string | null
  linkedPatientDisplayName: string | null
  linkedPatientLocation: string | null
  participants: string[]
  participantsEdited: boolean
  notes: string
  audioBlobKey: string | null
  transcript: string
  transcriptionMetadata: TranscriptionMetadata | null
  rawTranscriptionMetadata: unknown
  version: number
  privacyModeFloor: PrivacyMode
}

function positiveInteger(value: string | number | undefined, fallback: number, name: string): number {
  if (value == null || value === '') return fallback
  let parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`)
  return parsed
}

export function resolveWorkerOptions(input: WorkerOptions = {}, env: Environment = process.env): Required<WorkerOptions> {
  // Validate privacy policy during worker startup rather than discovering a
  // typo only after a job has been leased.
  resolveLocalFirstProcessingPolicy(env.LOCAL_FIRST_PROCESSING_POLICY)
  let pollVariable = env.QUEUE_POLL_INTERVAL_MS !== undefined ? 'QUEUE_POLL_INTERVAL_MS' : 'JOB_POLL_INTERVAL_MS'
  let pollValue = env.QUEUE_POLL_INTERVAL_MS ?? env.JOB_POLL_INTERVAL_MS
  return {
    workerId: input.workerId ?? (env.WORKER_ID?.trim() || `remix-${randomUUID()}`),
    lockMs: positiveInteger(input.lockMs ?? env.JOB_LOCK_MS, 30_000, 'JOB_LOCK_MS'),
    pollMs: positiveInteger(input.pollMs ?? pollValue, 2_000, pollVariable),
    dspyBaseUrl: (input.dspyBaseUrl ?? env.HANDOVER_DSPY_API_URL ?? 'http://127.0.0.1:8000').trim().replace(/\/+$/, ''),
    dspySharedSecret: input.dspySharedSecret ?? env.HANDOVER_DSPY_SHARED_SECRET ?? '',
    dspyTimeoutMs: positiveInteger(input.dspyTimeoutMs ?? env.HANDOVER_DSPY_TIMEOUT_MS, 60_000, 'HANDOVER_DSPY_TIMEOUT_MS'),
  }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function payloadString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function participantNames(value: unknown): string[] {
  let source = jsonValue(value)
  if (!Array.isArray(source)) return []
  let names = source.flatMap((entry) => {
    if (typeof entry === 'string') return [entry.trim()]
    let name = record(entry)?.name
    return typeof name === 'string' ? [name.trim()] : []
  }).filter(Boolean)
  return [...new Set(names)]
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseTranscriptionMetadata(value: unknown): TranscriptionMetadata | null {
  let parsed = record(jsonValue(value))
  let audioNoise = record(parsed?.audioNoise)
  let backgroundNoiseConcern = record(audioNoise?.backgroundNoiseConcern)
  let segments = parsed?.segments
  if (
    !parsed
    || typeof parsed.engine !== 'string'
    || typeof parsed.mocked !== 'boolean'
    || typeof parsed.language !== 'string'
    || !isFiniteNumber(parsed.durationMs)
    || !Array.isArray(parsed.interruptionSignals)
    || !Array.isArray(parsed.noiseSignals)
    || !Array.isArray(segments)
    || !audioNoise
    || !backgroundNoiseConcern
    || !Array.isArray(audioNoise.bursts)
    || !Array.isArray(audioNoise.affectedSections)
  ) return null
  let validSignals = [...parsed.interruptionSignals, ...parsed.noiseSignals].every((entry) => typeof entry === 'string')
  let validSegments = segments.every((entry) => {
    let segment = record(entry)
    return Boolean(
      segment
      && typeof segment.id === 'string'
      && isFiniteNumber(segment.startMs)
      && isFiniteNumber(segment.endMs)
      && typeof segment.text === 'string'
      && ['giver', 'receiver', 'unknown'].includes(String(segment.speaker))
      && (segment.confidence == null || isFiniteNumber(segment.confidence))
      && Array.isArray(segment.flags),
    )
  })
  return validSignals && validSegments ? parsed as unknown as TranscriptionMetadata : null
}

export function isStoredTranscriptMocked(transcript: string, metadata: unknown): boolean {
  if (record(jsonValue(metadata))?.mocked === true) return true
  return /^\s*(?:\[OUTGOING_NURSE]:\s*)?Mock transcription for\b/i.test(transcript)
}

function runId(kind: 'transcription' | 'analysis', job: HandoverJobRow): string {
  return `${kind}-${job.id}-${job.attempts}`
}

export type JobProcessingMode = PrivacyMode

/** A deployment may tighten queued work, but never downgrade a snapshotted local-first job. */
export function processingModeForJob(
  payload: HandoverJobPayload,
  env: Environment = process.env,
  privacyModeFloor: PrivacyMode = 'cloud',
): JobProcessingMode {
  return resolveLocalFirstProcessingPolicy(env.LOCAL_FIRST_PROCESSING_POLICY) === 'required'
    || privacyModeFloor === 'local-first'
    || normalizePrivacyMode(payload.privacyMode) === 'local-first'
    ? 'local-first'
    : 'cloud'
}

/** Once work is tightened to local-first, its durable payload cannot downgrade. */
export function ratchetPrivacyModeForProcessing(
  payload: HandoverJobPayload,
  processingMode: JobProcessingMode,
): HandoverJobPayload {
  if (processingMode !== 'local-first' || normalizePrivacyMode(payload.privacyMode) === 'local-first') {
    return payload
  }
  return {
    ...payload,
    privacyMode: 'local-first',
    privacyPolicyVersion: currentPrivacyPolicyVersion,
  }
}

export function providerForTranscription(job: HandoverJobRow, handoverAudioBlobKey: string | null): string {
  if (payloadString(job.payload.manualTranscript)) return 'manual-entry'
  let audioBlobKey = payloadString(job.payload.audioBlobKey)
    ?? (job.kind === 'extend' ? null : handoverAudioBlobKey)
  if (audioBlobKey) return 'omi-medical-edge-1'
  if (process.env.MOCK_TRANSCRIPTION === 'true') return 'mock-transcription'
  return 'omi-medical-edge-1'
}

class DspyPredictionError extends Error {
  readonly code = 'DSPY_PREDICTION_FAILED'

  constructor(message: string) {
    super(message)
    this.name = 'DspyPredictionError'
  }
}

export type DspyProvenance = {
  provider: string
  model: string
}

function boundedDspyIdentity(
  value: unknown,
  name: 'provider' | 'model',
  maximumLength: number,
): string {
  let candidate = optionalString(value)
  if (
    !candidate
    || candidate.length > maximumLength
    || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(candidate)
  ) {
    throw new DspyPredictionError(`/provenance returned invalid ${name}`)
  }
  return candidate
}

function assertDspyPredictionProvenance(
  value: unknown,
  expected: DspyProvenance,
  path: string,
): void {
  let response = record(value)
  if (!response || response.model !== expected.model) {
    throw new DspyPredictionError(`${path} returned mismatched model provenance`)
  }
}

export async function fetchDspyProvenance(
  baseUrl: string,
  timeoutMs: number,
  secret?: string,
  fetcher: typeof fetch = fetch,
): Promise<DspyProvenance> {
  let headers = new Headers({ Accept: 'application/json' })
  if (secret) headers.set('x-handover-worker-token', secret)
  let response: Response
  try {
    response = await fetcher(new URL('/provenance', baseUrl), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new DspyPredictionError('/provenance failed')
  }
  if (!response.ok) throw new DspyPredictionError(`/provenance returned ${response.status}`)
  let payload: Record<string, unknown> | null
  try {
    payload = record(await response.json())
  } catch {
    throw new DspyPredictionError('/provenance returned invalid JSON')
  }
  if (!payload) throw new DspyPredictionError('/provenance returned invalid payload')
  return {
    provider: boundedDspyIdentity(payload.provider, 'provider', 120),
    model: boundedDspyIdentity(payload.model, 'model', 240),
  }
}

async function predict(
  baseUrl: string,
  path: string,
  transcript: string,
  timeoutMs: number,
  secret?: string,
): Promise<unknown> {
  let maxAttempts = 2
  let attemptTimeoutMs = Math.max(1_000, Math.floor(timeoutMs / maxAttempts))
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let headers = new Headers({ 'Content-Type': 'application/json' })
    if (secret) headers.set('x-handover-worker-token', secret)
    let response: Response
    try {
      response = await fetch(new URL(path, baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: transcript }),
        signal: AbortSignal.timeout(attemptTimeoutMs),
      })
    } catch {
      if (attempt < maxAttempts) continue
      throw new DspyPredictionError(`${path} failed`)
    }
    if (!response.ok) {
      if (attempt < maxAttempts && (response.status === 408 || response.status === 429 || response.status >= 500)) continue
      throw new DspyPredictionError(`${path} returned ${response.status}`)
    }
    try {
      return await response.json()
    } catch {
      throw new DspyPredictionError(`${path} returned invalid JSON`)
    }
  }
  throw new DspyPredictionError(`${path} failed`)
}

function hasCurrentLease(result: { rows?: Record<string, unknown>[] }): boolean {
  return (result.rows?.length ?? 0) === 1
}

async function assertCurrentLease(
  db: Database,
  job: HandoverJobRow,
  workerId: string,
  options: { lockRows?: boolean } = {},
): Promise<void> {
  let result = await db.exec(sql`
    select h.id
    from handovers h
    join handover_jobs j on j.id = ${job.id} and j.handover_id = h.id
    where h.id = ${job.handover_id}
      and h.current_job_id = ${job.id}
      and h.version = ${job.revision}
      and h.processing_lease_until > now()
      and j.revision = ${job.revision}
      and j.status = 'running'
      and j.locked_by = ${workerId}
      and j.locked_until > now()
    ${options.lockRows ? sql`for update of h, j` : sql``}
  `)
  if (!hasCurrentLease(result)) throw new Error('Lost handover job lease.')
}

async function loadHandoverWork(db: Database, job: HandoverJobRow, workerId: string): Promise<HandoverWork> {
  await assertCurrentLease(db, job, workerId)
  let result = await db.exec(sql`
    select id, title, direction, source_department, destination_department, context_type,
      linked_patient_key, linked_patient_display_name, linked_patient_location, participants,
      participants_edited, notes, audio_blob_key, transcript, transcription_metadata, version,
      privacy_mode_floor
    from handovers
    where id = ${job.handover_id} and current_job_id = ${job.id} and version = ${job.revision}
    limit 1
  `)
  let row = result.rows?.[0]
  if (!row) throw new Error('The handover revision is no longer available for this job.')
  return {
    id: String(row.id),
    title: String(row.title),
    direction: optionalString(row.direction) ?? '',
    sourceDepartment: String(row.source_department),
    destinationDepartment: String(row.destination_department ?? ''),
    contextType: String(row.context_type),
    linkedPatientKey: optionalString(row.linked_patient_key),
    linkedPatientDisplayName: optionalString(row.linked_patient_display_name),
    linkedPatientLocation: optionalString(row.linked_patient_location),
    participants: participantNames(row.participants),
    participantsEdited: row.participants_edited === true,
    notes: String(row.notes ?? ''),
    audioBlobKey: optionalString(row.audio_blob_key),
    transcript: String(row.transcript ?? '').trim(),
    transcriptionMetadata: parseTranscriptionMetadata(row.transcription_metadata),
    rawTranscriptionMetadata: row.transcription_metadata,
    version: Number(row.version),
    privacyModeFloor: row.privacy_mode_floor === 'local-first' ? 'local-first' : 'cloud',
  }
}

async function captureExtensionRollback(
  db: Database,
  job: HandoverJobRow,
  workerId: string,
  handover: HandoverWork,
): Promise<HandoverJobPayload> {
  let payload: HandoverJobPayload = {
    ...job.payload,
    rollbackTranscript: handover.transcript,
    rollbackTranscriptionMetadata: record(jsonValue(handover.rawTranscriptionMetadata)),
  }
  await db.transaction(async (tx) => {
    await assertCurrentLease(tx, job, workerId, { lockRows: true })
    let updated = await tx.exec(sql`
      update handover_jobs set payload=${JSON.stringify(payload)}::jsonb, updated_at=now()
      where id=${job.id} and handover_id=${job.handover_id} and status='running' and locked_by=${workerId}
      returning id
    `)
    if (!hasCurrentLease(updated)) throw new Error('Lost handover job lease.')
  })
  return payload
}

function persistedAnalysis(value: unknown): PersistedHandoverAnalysis | null {
  let parsed = record(jsonValue(value))
  if (
    !parsed
    || typeof parsed.headline !== 'string'
    || typeof parsed.overview !== 'string'
    || !record(parsed.structuredSummary)
    || !record(parsed.structuredSummaryMeta)
    || !Array.isArray(parsed.checklistFocus)
    || !Array.isArray(parsed.patients)
    || !Array.isArray(parsed.communicationRisks)
    || !record(parsed.feedback)
    || !record(parsed.interruptionAssessment)
    || !record(parsed.analysisReadiness)
  ) return null
  return parsed as unknown as PersistedHandoverAnalysis
}

function patientWorksheetFields(value: unknown): Record<string, unknown[]> | null {
  let analysis = record(jsonValue(value))
  let collection = record(analysis?.patientWorksheetFields)
  if (!collection) return null
  let entries = Object.entries(collection)
    .filter((entry): entry is [string, unknown[]] => Boolean(entry[0]) && Array.isArray(entry[1]))
  return entries.length ? Object.fromEntries(entries) : null
}

function analysisPriority(value: unknown): TaskProjection['priority'] {
  if (value === 'low' || value === 'medium' || value === 'high') return value
  return value === 'urgent' ? 'high' : 'medium'
}

function taskStatus(value: unknown): TaskProjection['status'] {
  return value === 'in_progress' || value === 'done' ? value : 'open'
}

function taskSource(value: unknown): TaskProjection['source'] {
  return value === 'uncertainty' || value === 'history' || value === 'manual' ? value : 'transcript'
}

function isoTimestamp(value: unknown): string | null {
  if (value == null) return null
  let date = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

async function readExistingAnalysisResult(
  db: Database,
  job: HandoverJobRow,
  options: { lockProjectionRows?: boolean } = {},
): Promise<HandoverAnalysisResult | null> {
  let projectionLock = options.lockProjectionRows ? sql`for update` : sql``
  let analysisResult = await db.exec(sql`
    select analysis from handovers
    where id = ${job.handover_id} and current_job_id = ${job.id} and version = ${job.revision}
    limit 1
  `)
  let analysis = persistedAnalysis(analysisResult.rows?.[0]?.analysis)
  if (!analysis) return null

  // Keep these sequential: a transaction-bound pg client must not execute
  // concurrent queries, and the final persistence path uses this helper while
  // holding the authoritative handover/job locks.
  let patientResult = await db.exec(sql`
    select id, patient_key, display_name, location, acuity_score, risk_score,
      workflow_score, priority_reason
    from handover_patients where handover_id = ${job.handover_id}
    order by created_at, id
    ${projectionLock}
  `)
  let taskResult = await db.exec(sql`
    select id, patient_key, title, due_label, due_at, priority, status,
      reminder_enabled, carried_forward, source, related_uncertainty_id
    from handover_tasks where handover_id = ${job.handover_id}
    order by created_at, id
    ${projectionLock}
  `)
  let patientProjections: PatientProjection[] = (patientResult.rows ?? []).map((row) => ({
    id: String(row.id),
    patientKey: String(row.patient_key),
    displayName: String(row.display_name),
    location: String(row.location),
    acuityScore: Number(row.acuity_score),
    riskScore: Number(row.risk_score),
    workflowScore: Number(row.workflow_score),
    priorityReason: String(row.priority_reason),
  }))
  let taskProjections: TaskProjection[] = (taskResult.rows ?? []).map((row) => ({
    id: String(row.id),
    patientKey: String(row.patient_key),
    title: String(row.title),
    dueLabel: String(row.due_label),
    dueAt: isoTimestamp(row.due_at),
    priority: analysisPriority(row.priority),
    status: taskStatus(row.status),
    reminderEnabled: row.reminder_enabled === true,
    carriedForward: row.carried_forward === true,
    source: taskSource(row.source),
    relatedUncertaintyId: optionalString(row.related_uncertainty_id),
  }))
  return { analysis, patientProjections, taskProjections }
}

async function loadExistingAnalysisResult(
  db: Database,
  job: HandoverJobRow,
  workerId: string,
): Promise<HandoverAnalysisResult | null> {
  await assertCurrentLease(db, job, workerId)
  let existing = await readExistingAnalysisResult(db, job)
  await assertCurrentLease(db, job, workerId)
  return existing
}

function continuationNotes(
  existingNotes: string,
  existing: HandoverAnalysisResult | null,
): string {
  if (!existing) return existingNotes
  let patientContext = existing.analysis.patients.slice(0, 6).map((patient) => {
    let openTasks = existing.taskProjections
      .filter((task) => task.patientKey === patient.patientKey && task.status !== 'done')
      .slice(0, 4)
      .map((task) => task.title)
    return {
      patientKey: patient.patientKey,
      displayName: patient.displayName,
      location: patient.location,
      situation: patient.summary.situation,
      openTasks,
    }
  })
  return [
    existingNotes.trim(),
    'Existing handover context below is for identity and pronoun resolution only. Do not present it as new continuation evidence.',
    JSON.stringify(patientContext),
  ].filter(Boolean).join('\n')
}

type PrivacyIdentityReference = {
  patientKey?: string | null
  displayName?: string | null
}

function addIdentityDenyTerms(
  target: LocalPrivacyDenyTerm[],
  reference: PrivacyIdentityReference,
): void {
  let patientKey = optionalString(reference.patientKey)
  if (patientKey && !isPlaceholderPatientKey(patientKey)) {
    target.push({ term: patientKey, label: 'ID_NUM' })
  }
  let displayName = optionalString(reference.displayName)
  if (displayName) target.push({ term: displayName, label: 'PERSON' })
}

function handoverPrivacyDenyTerms(
  handover: HandoverWork,
  analyses: readonly (HandoverAnalysisResult | null | undefined)[],
  priorFindings: readonly LocalPrivacyDenyTerm[],
): LocalPrivacyDenyTerm[] {
  let values: LocalPrivacyDenyTerm[] = []
  addIdentityDenyTerms(values, {
    patientKey: handover.linkedPatientKey,
    displayName: handover.linkedPatientDisplayName,
  })
  for (let participant of handover.participants) {
    values.push({ term: participant, label: 'PERSON' })
  }
  for (let result of analyses) {
    if (!result) continue
    for (let patient of result.analysis.patients) addIdentityDenyTerms(values, patient)
    for (let patient of result.patientProjections) addIdentityDenyTerms(values, patient)
    for (let participant of result.analysis.participants) {
      values.push({ term: participant, label: 'PERSON' })
    }
  }
  let normalized = normalizeLocalPrivacyDenyTerms(values)
  let protectedTerms = new Set(normalized.map((value) => value.term))
  // Exact prior OpenMed findings cover patient identifiers which are present
  // in continuation context but are not represented by the identity fields.
  for (let finding of priorFindings) {
    if (normalized.length >= maximumLocalPrivacyDenyTerms) break
    let [candidate] = normalizeLocalPrivacyDenyTerms([finding])
    if (!candidate || protectedTerms.has(candidate.term)) continue
    normalized.push(candidate)
    protectedTerms.add(candidate.term)
  }
  return normalized
}

async function loadPriorPrivacyDenyTerms(
  db: Database,
  job: HandoverJobRow,
  workerId: string,
): Promise<LocalPrivacyDenyTerm[]> {
  await assertCurrentLease(db, job, workerId)
  let result = await db.exec(sql`
    select finding.original_text, finding.canonical_label,
      finding.entity_type, finding.label
    from local_privacy_findings finding
    join local_privacy_audits audit on audit.id = finding.audit_id
    where audit.handover_id = ${job.handover_id}
      and audit.revision is not null
      and audit.revision < ${job.revision}
    order by audit.revision desc, audit.created_at desc, finding.ordinal
    limit 128
  `)
  await assertCurrentLease(db, job, workerId)
  return priorPrivacyDenyTerms(result.rows ?? [])
}

export function priorPrivacyDenyTerms(
  rows: readonly Record<string, unknown>[],
): LocalPrivacyDenyTerm[] {
  let values = rows.flatMap((row) => {
    let term = optionalString(row.original_text)
    let canonicalLabel = optionalString(row.canonical_label)
    let label = (canonicalLabel ? [canonicalLabel] : [row.entity_type, row.label])
      .map(optionalString)
      .filter((value): value is string => value != null)
      .map((value) => value.toUpperCase())
      .find(isProtectedLocalPrivacyDenyTermLabel)
    return term && label ? [{ term, label }] : []
  })
  return normalizeLocalPrivacyDenyTerms(values)
}

async function closeAbandonedRuns(db: Database, job: HandoverJobRow, workerId: string): Promise<void> {
  await assertCurrentLease(db, job, workerId)
  let message = 'The previous worker lease expired before this run completed.'
  await db.transaction(async (tx) => {
    await assertCurrentLease(tx, job, workerId, { lockRows: true })
    await tx.exec(sql`
      update transcription_runs set status = 'failed', failed_at = now(), error_message = ${message}
      where job_id = ${job.id} and status = 'running'
    `)
    await tx.exec(sql`
      update analysis_runs set status = 'failed', failed_at = now(), error_message = ${message}
      where job_id = ${job.id} and status = 'running'
    `)
  })
}

async function beginTranscriptionRun(
  db: Database,
  job: HandoverJobRow,
  workerId: string,
  id: string,
  provider: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await assertCurrentLease(tx, job, workerId, { lockRows: true })
    await tx.exec(sql`
      insert into transcription_runs
        (id, handover_id, job_id, revision, provider, status, metadata, started_at)
      values (${id}, ${job.handover_id}, ${job.id}, ${job.revision}, ${provider}, 'running',
        ${JSON.stringify({ attempt: job.attempts })}::jsonb, now())
    `)
    let updated = await tx.exec(sql`
      update handovers set processing_status = 'transcribing', error_message = null, updated_at = now()
      where id = ${job.handover_id} and current_job_id = ${job.id} and version = ${job.revision}
      returning id
    `)
    if (!hasCurrentLease(updated)) throw new Error('Lost handover job lease.')
    await notifyHandoverProcessingChanged(tx, job.handover_id)
  })
}

function transcriptionRunMetadata(result: TranscriptionResult, job: HandoverJobRow): Record<string, unknown> {
  return {
    engine: result.metadata.engine,
    mocked: result.metadata.mocked,
    language: result.metadata.language,
    durationMs: result.metadata.durationMs,
    transcription_elapsed_ms: result.metadata.transcriptionElapsedMs ?? null,
    segmentCount: result.metadata.segments.length,
    audioNoiseAvailable: result.metadata.audioNoise.available,
    backgroundNoiseLevel: result.metadata.audioNoise.backgroundNoiseConcern.level,
    processingMode: processingModeForJob(job.payload),
    attempt: job.attempts,
  }
}

async function completeTranscriptionRun(
  db: Database,
  job: HandoverJobRow,
  workerId: string,
  id: string,
  result: TranscriptionResult,
  newSegmentCount: number,
  processedAudioBlobKey: string | null,
  deletionRequired: boolean,
): Promise<void> {
  let retryPayload = {
    ...job.payload,
    retryFrom: 'analysis' as const,
    audioCleanupJobId: processedAudioBlobKey ? job.id : undefined,
    ...(processedAudioBlobKey ? { audioBlobKey: processedAudioBlobKey } : {}),
    ...(job.kind === 'extend' ? { retrySegmentCount: Math.max(1, newSegmentCount) } : {}),
  }
  if (job.kind !== 'extend') delete retryPayload.retrySegmentCount
  await db.transaction(async (tx) => {
    await assertCurrentLease(tx, job, workerId, { lockRows: true })
    let updated = await tx.exec(sql`
      update handovers set transcript = ${result.transcript},
        transcription_metadata = ${JSON.stringify(result.metadata)}::jsonb,
        processing_status = 'analysing', error_message = null, updated_at = now()
      where id = ${job.handover_id} and current_job_id = ${job.id} and version = ${job.revision}
      returning id
    `)
    if (!hasCurrentLease(updated)) throw new Error('Lost handover job lease.')
    await notifyHandoverProcessingChanged(tx, job.handover_id)
    await tx.exec(sql`
      update transcription_runs set status = 'completed',
        metadata = ${JSON.stringify(transcriptionRunMetadata(result, job))}::jsonb,
        completed_at = now(), failed_at = null, error_message = null
      where id = ${id} and job_id = ${job.id} and status = 'running'
    `)
    await tx.exec(sql`
      update handover_jobs set payload = ${JSON.stringify(retryPayload)}::jsonb, updated_at = now()
      where id = ${job.id} and status = 'running' and locked_by = ${workerId}
    `)
    // Cleanup intent commits with the durable transcript/run boundary. The
    // storage delete remains outside this transaction and can be retried by
    // the independent cleanup queue after a crash or transient failure.
    await scheduleSuccessfulTranscriptionAudioCleanupInTransaction(tx, {
      handoverId: job.handover_id,
      jobId: job.id,
      revision: job.revision,
      processedAudioBlobKey,
      transcriptionMocked: result.metadata.mocked,
      deletionRequired,
    }, process.env)
  })
}

async function markHandoverAnalysing(db: Database, job: HandoverJobRow, workerId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertCurrentLease(tx, job, workerId, { lockRows: true })
    let updated = await tx.exec(sql`
      update handovers set processing_status = 'analysing', error_message = null, updated_at = now()
      where id = ${job.handover_id} and current_job_id = ${job.id} and version = ${job.revision}
      returning id
    `)
    if (!hasCurrentLease(updated)) throw new Error('Lost handover job lease.')
    await notifyHandoverProcessingChanged(tx, job.handover_id)
  })
}

async function beginAnalysisRun(
  db: Database,
  job: HandoverJobRow,
  workerId: string,
  id: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await assertCurrentLease(tx, job, workerId, { lockRows: true })
    await tx.exec(sql`
      insert into analysis_runs
        (id, handover_id, job_id, revision, provider, status, metadata, started_at)
      values (${id}, ${job.handover_id}, ${job.id}, ${job.revision}, 'openai+dspy', 'running',
        ${JSON.stringify({ attempt: job.attempts })}::jsonb, now())
    `)
  })
}

function analysisRunMetadata(result: HandoverAnalysisResult, job: HandoverJobRow): Record<string, unknown> {
  return {
    openaiModel: process.env.OPENAI_MODEL?.trim() || 'gpt-5.5',
    checklistItemCount: result.analysis.checklistFocus.length,
    sbarEvidenceCount: result.analysis.sbarEvidence.length,
    unknownFactCount: result.analysis.patients.reduce((count, patient) => count + patient.uncertainties.length, 0),
    patientCount: result.patientProjections.length,
    taskCount: result.taskProjections.length,
    processingMode: processingModeForJob(job.payload),
    attempt: job.attempts,
  }
}

async function persistCompletedAnalysis(
  db: Database,
  job: HandoverJobRow,
  workerId: string,
  analysisRunId: string,
  incoming: HandoverAnalysisResult,
  handover: HandoverWork,
): Promise<void> {
  await db.transaction(async (tx) => {
    await assertCurrentLease(tx, job, workerId, { lockRows: true })
    // The model calls can take long enough for a clinician to edit the review.
    // Re-read and lock the authoritative projections only at the commit boundary,
    // then merge the continuation into that latest state. The earlier snapshot is
    // used solely to give the model identity/pronoun context.
    let latest = job.kind === 'extend'
      ? await readExistingAnalysisResult(tx, job, { lockProjectionRows: true })
      : null
    let result = latest ? mergeHandoverContinuation(latest, incoming) : incoming
    // Review metadata and worksheet edits can be submitted while analysis is
    // running. Read them at the commit boundary so the model result cannot
    // erase clinician-owned identity, participant, or field review state.
    let current = await tx.exec(sql`
      select title, participants, participants_edited, linked_patient_key, linked_patient_display_name,
        linked_patient_location, analysis
      from handovers
      where id=${job.handover_id} and current_job_id=${job.id} and version=${job.revision}
      limit 1
    `)
    let currentRow = current.rows?.[0]
    if (!currentRow) throw new Error('Lost handover job lease.')
    let initialReviewMetadata = {
      title: handover.title,
      participants: handover.participants,
      participantsEdited: handover.participantsEdited,
      linkedPatientKey: handover.linkedPatientKey,
      linkedPatientDisplayName: handover.linkedPatientDisplayName,
      linkedPatientLocation: handover.linkedPatientLocation,
    }
    let currentReviewMetadata = {
      title: String(currentRow.title),
      participants: participantNames(currentRow.participants),
      participantsEdited: currentRow.participants_edited === true,
      linkedPatientKey: optionalString(currentRow.linked_patient_key),
      linkedPatientDisplayName: optionalString(currentRow.linked_patient_display_name),
      linkedPatientLocation: optionalString(currentRow.linked_patient_location),
    }
    let reviewMetadata = job.kind === 'create'
      ? preserveCreateReviewMetadata(result, initialReviewMetadata, currentReviewMetadata)
      : preserveExtensionReviewMetadata(result, initialReviewMetadata, currentReviewMetadata)
    result = reviewMetadata.result
    let worksheetFields = patientWorksheetFields(currentRow.analysis)
    if (worksheetFields) {
      result = {
        ...result,
        analysis: { ...result.analysis, patientWorksheetFields: worksheetFields },
      }
    }
    let generatedTitle = handover.contextType === 'shift-handover'
      ? handover.title
      : result.analysis.titleSuggestion.trim() || handover.title
    let finalTitle = reviewMetadata.titleOverride ?? generatedTitle
    let finalParticipantNames = reviewMetadata.participantsOverride
      ?? (result.analysis.participants.length ? result.analysis.participants : handover.participants)
    let finalParticipants = finalParticipantNames.map((name) => ({ name }))
    let updated = await tx.exec(sql`
      update handovers set analysis = ${JSON.stringify(result.analysis)}::jsonb,
        title = ${finalTitle}, participants = ${JSON.stringify(finalParticipants)}::jsonb,
        error_message = null, updated_at = now()
      where id = ${job.handover_id} and current_job_id = ${job.id} and version = ${job.revision}
      returning id
    `)
    if (!hasCurrentLease(updated)) throw new Error('Lost handover job lease.')

    await tx.exec(sql`delete from handover_patients where handover_id = ${job.handover_id}`)
    for (let patient of result.patientProjections) {
      await tx.exec(sql`
        insert into handover_patients
          (id, handover_id, patient_key, display_name, location, acuity_score, risk_score,
            workflow_score, priority_reason, created_at)
        values (${patient.id}, ${job.handover_id}, ${patient.patientKey}, ${patient.displayName},
          ${patient.location}, ${patient.acuityScore}, ${patient.riskScore}, ${patient.workflowScore},
          ${patient.priorityReason}, now())
      `)
    }

    await tx.exec(sql`
      delete from handover_tasks where handover_id = ${job.handover_id} and source = 'transcript'
    `)
    for (let task of result.taskProjections.filter((projection) => projection.source === 'transcript')) {
      await tx.exec(sql`
        insert into handover_tasks
          (id, handover_id, patient_key, title, due_label, due_at, priority,
            status, reminder_enabled, carried_forward, source, related_uncertainty_id, created_at, updated_at)
        values (${task.id}, ${job.handover_id}, ${task.patientKey}, ${task.title},
          ${task.dueLabel}, ${task.dueAt}::timestamptz, ${task.priority}, ${task.status},
          ${task.reminderEnabled}, ${task.carriedForward}, ${task.source},
          ${task.relatedUncertaintyId}, now(), now())
        on conflict (handover_id, patient_key, related_uncertainty_id)
          where related_uncertainty_id is not null
          do nothing
      `)
    }

    let completedRun = await tx.exec(sql`
      update analysis_runs set status = 'completed',
        metadata = ${JSON.stringify(analysisRunMetadata(result, job))}::jsonb,
        completed_at = now(), failed_at = null, error_message = null
      where id = ${analysisRunId} and job_id = ${job.id} and status = 'running'
      returning id
    `)
    if (!hasCurrentLease(completedRun)) throw new Error('Lost handover job lease.')
    if (!await completeHandoverJob(tx, { jobId: job.id, workerId })) {
      throw new Error('Lost handover job lease.')
    }
  })
}

function safeProcessingError(error: unknown, stage: ProcessingStage): string {
  let message = error instanceof Error ? error.message : ''
  if (message === 'Lost handover job lease.') return message
  if (error instanceof RequiredAudioDeletionError) return error.message
  if (record(error)?.code === 'LOCAL_FIRST_AUDIO_STORAGE_NOT_LOCAL') {
    return 'Local-first audio requires workstation-local filesystem storage.'
  }
  if (record(error)?.code === 'LOCAL_PRIVACY_SERVICE_FAILED') {
    if (stage === 'transcription') {
      return 'Local transcription failed. The source recording is retained and can be retried.'
    }
    return 'Local-first processing failed before any clinical content was sent to cloud services.'
  }
  if (/^OPENAI_API_KEY is required/.test(message)) return message
  if (/^\/predict\/(?:checklist|sbar|unknown-fact) (?:failed|returned (?:\d{3}|invalid JSON|invalid payload))$/.test(message)) {
    return `The clinical evidence service failed during ${stage}.`
  }
  if (/^OpenAI returned /.test(message)) return message.slice(0, 240)
  if (/^No transcript or audio recording|^No usable transcript|^Manual transcript is empty/.test(message)) {
    return message.slice(0, 240)
  }
  if (stage === 'transcription') return 'Transcription failed. The source recording is retained and can be retried.'
  if (stage === 'analysis') return 'Analysis failed. The transcript is retained and can be retried.'
  return 'Handover processing failed. The source content is retained and can be retried.'
}

/**
 * Preserve enough provider/schema/database context to diagnose a failed run
 * without copying clinical input, model output, or exception messages into
 * logs and durable metadata.
 */
export function processingFailureDiagnostic(error: unknown, stage: ProcessingStage): ProcessingFailureDiagnostic {
  let details = record(error)
  let errorType = error instanceof Error ? error.name : 'UnknownError'
  let providerCode = typeof details?.code === 'string' ? details.code : ''
  let issues = Array.isArray(details?.issues)
    ? details.issues.flatMap((value) => {
        let issue = record(value)
        if (!issue) return []
        let code = typeof issue.code === 'string' ? issue.code : 'unknown'
        let path = Array.isArray(issue.path)
          ? issue.path.slice(0, 8).map((segment) => String(segment)).join('.')
          : ''
        return [{ code, path }]
      }).slice(0, 20)
    : []
  let errorCode = providerCode
    || (errorType === 'PatientAnalysisReconciliationError'
      ? 'PATIENT_ANALYSIS_RECONCILIATION_FAILED'
      : issues.length
        ? 'STRUCTURED_OUTPUT_VALIDATION_FAILED'
        : 'UNCLASSIFIED_PROCESSING_FAILURE')
  let constraint = typeof details?.constraint === 'string' ? details.constraint : undefined
  let requestName = typeof details?.requestName === 'string'
    && /^(?:base_handover_[a-z_]+|reader_friendly_sbar_summary)$/.test(details.requestName)
    ? details.requestName
    : undefined
  return {
    stage,
    errorType,
    errorCode,
    ...(requestName ? { requestName } : {}),
    ...(constraint ? { constraint } : {}),
    ...(issues.length ? { issues } : {}),
  }
}

async function markRunFailed(
  db: Database,
  table: 'transcription_runs' | 'analysis_runs',
  id: string,
  job: HandoverJobRow,
  workerId: string,
  errorMessage: string,
  diagnostic: ProcessingFailureDiagnostic,
): Promise<void> {
  let statement = table === 'transcription_runs'
    ? sql`
      update transcription_runs set status = 'failed', failed_at = now(), error_message = ${errorMessage},
        metadata = coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({ failure: diagnostic })}::jsonb
      where id = ${id} and job_id = ${job.id} and status = 'running'
        and exists (select 1 from handover_jobs where id = ${job.id} and status = 'running' and locked_by = ${workerId})
    `
    : sql`
      update analysis_runs set status = 'failed', failed_at = now(), error_message = ${errorMessage},
        metadata = coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({ failure: diagnostic })}::jsonb
      where id = ${id} and job_id = ${job.id} and status = 'running'
        and exists (select 1 from handover_jobs where id = ${job.id} and status = 'running' and locked_by = ${workerId})
    `
  await db.exec(statement)
}

export async function transcribeForJob(
  handover: HandoverWork,
  job: HandoverJobRow,
  services: Pick<WorkerServices, 'transcription' | 'audioNoise'>,
  processingMode: JobProcessingMode,
): Promise<{
  result: TranscriptionResult
  analysisInput: TranscriptionResult
  newSegmentCount: number
  processedAudioBlobKey: string | null
}> {
  let manualTranscript = payloadString(job.payload.manualTranscript)
  let payloadAudioKey = payloadString(job.payload.audioBlobKey)
  let audioBlobKey = job.kind === 'extend' ? payloadAudioKey : payloadAudioKey ?? handover.audioBlobKey
  let processedAudioBlobKey = manualTranscript ? null : audioBlobKey
  let input = {
    manualTranscript,
    audioBlobKey,
    audioOriginalFilename: payloadString(job.payload.audioOriginalFilename),
    mockContext: 'queued handover audio',
  }
  // Reject an incompatible remote store before starting the noise analyzer,
  // which also reads the raw audio object.
  if (
    processingMode === 'local-first'
    && !manualTranscript
    && !isLocalFirstAudioStorageBackendCompatible()
  ) {
    throw new LocalFirstAudioStorageError()
  }
  if (processingMode === 'local-first' && !manualTranscript && !audioBlobKey) {
    throw new Error('No transcript or audio recording is available for processing.')
  }
  let transcribe = () => services.transcription.transcribe(input)
  let noisePromise = processedAudioBlobKey
    ? services.audioNoise.analyze(processedAudioBlobKey)
    : Promise.resolve(createEmptyAudioNoiseMetrics())
  if (job.kind === 'extend' && handover.transcript && !isStoredTranscriptMocked(handover.transcript, handover.rawTranscriptionMetadata)) {
    let analysisInput = await transcribe()
    analysisInput = {
      ...analysisInput,
      metadata: attachAudioNoiseMetrics(analysisInput.metadata, await noisePromise),
    }
    let result = appendTranscriptToExisting({
      previousTranscript: handover.transcript,
      previousMetadata: handover.transcriptionMetadata,
      nextTranscript: analysisInput.transcript,
      nextMetadata: analysisInput.metadata,
    })
    return {
      result,
      analysisInput,
      newSegmentCount: analysisInput.metadata.segments.length,
      processedAudioBlobKey,
    }
  }
  let result = await transcribe()
  result = { ...result, metadata: attachAudioNoiseMetrics(result.metadata, await noisePromise) }
  return {
    result,
    analysisInput: result,
    newSegmentCount: result.metadata.segments.length,
    processedAudioBlobKey,
  }
}

async function scheduleProcessedAudioCleanup(
  retention: SuccessfulTranscriptionAudioRetention,
  job: HandoverJobRow,
  processedAudioBlobKey: string | null,
  deletionRequired: boolean,
): Promise<void> {
  let cleanupJobId = payloadString(job.payload.audioCleanupJobId)
  let cleanupDependencies = job.payload.audioCleanupDependencies ?? (cleanupJobId
    ? [{ jobId: cleanupJobId, revision: job.revision }]
    : [])
  if (!processedAudioBlobKey && cleanupDependencies.length === 0) {
    // A manual transcript has no recording to delete. Every other
    // local-first analysis retry must carry either the raw-object reference or
    // a durable cleanup dependency; absence is not evidence of deletion.
    if (
      deletionRequired
      && job.payload.retryFrom === 'analysis'
      && !payloadString(job.payload.manualTranscript)
    ) {
      throw new RequiredAudioDeletionError()
    }
    return
  }
  try {
    // Recipient analysis-only copies deliberately do not retain a raw-audio
    // reference. Their durable dependency is the source transcription cleanup
    // job, whose outbox row survives source handover/job deletion.
    let results = cleanupDependencies.length
      ? await Promise.all(cleanupDependencies.map((dependency) =>
          retention.confirmRequiredDeletion({
            jobId: dependency.jobId,
            revision: dependency.revision,
          })))
      : [await retention.release({
          handoverId: job.handover_id,
          jobId: job.id,
          revision: job.revision,
          processedAudioBlobKey,
          deletionRequired,
        })]
    if (deletionRequired && results.some((result) =>
      !isSuccessfulTranscriptionAudioDeletionConfirmed(result))) {
      throw new RequiredAudioDeletionError()
    }
  } catch (error) {
    if (deletionRequired) {
      throw error instanceof RequiredAudioDeletionError ? error : new RequiredAudioDeletionError()
    }
    // The transcript and run are already durable. The analysis-only retry path
    // invokes this again after a crash, and the independent cleanup loop also
    // reclaims any outbox row that was successfully scheduled.
    console.warn('Post-transcription audio cleanup could not be scheduled; analysis will continue.')
  }
}

/** Confirm every immutable source-recording dependency before full text can reach cloud analysis. */
export async function confirmRequiredPrivacyAudioCleanupDependencies(
  retention: Pick<SuccessfulTranscriptionAudioRetention, 'confirmRequiredDeletion'>,
  dependencies: readonly { jobId: string; revision: number }[],
): Promise<void> {
  let results = await Promise.all(dependencies.map((dependency) =>
    retention.confirmRequiredDeletion({
      jobId: dependency.jobId,
      revision: dependency.revision,
    })))
  if (results.some((result) => !isSuccessfulTranscriptionAudioDeletionConfirmed(result))) {
    throw new RequiredAudioDeletionError()
  }
}

export function fullAnalysisRecoveryPrivacyCleanupIsProvable(input: {
  processingMode: JobProcessingMode
  analysisMode: 'full' | 'continuation'
  jobKind: HandoverJobRow['kind']
  analysisRetry: boolean
  hasRollbackTranscript: boolean
  priorTranscript: string | null
  priorDependencies: readonly { jobId: string; revision: number }[]
  rollbackEngine: unknown
}): boolean {
  if (
    input.processingMode !== 'local-first'
    || input.analysisMode !== 'full'
    || input.jobKind !== 'extend'
  ) return true
  if (input.analysisRetry && !input.hasRollbackTranscript) return false
  return !input.priorTranscript
    || input.priorDependencies.length > 0
    || input.rollbackEngine === 'manual-entry'
}

class RequiredAudioDeletionError extends Error {
  readonly code = 'LOCAL_AUDIO_DELETION_NOT_CONFIRMED'

  constructor() {
    super('Local-first processing is paused until source recording deletion is confirmed.')
    this.name = 'RequiredAudioDeletionError'
  }
}

class LocalFirstAudioStorageError extends Error {
  readonly code = 'LOCAL_FIRST_AUDIO_STORAGE_NOT_LOCAL'

  constructor() {
    super('Local-first audio requires workstation-local filesystem storage.')
    this.name = 'LocalFirstAudioStorageError'
  }
}

async function persistProcessingModeRatchet(
  db: Database,
  job: HandoverJobRow,
  workerId: string,
  processingMode: JobProcessingMode,
): Promise<HandoverJobPayload> {
  let payload = ratchetPrivacyModeForProcessing(job.payload, processingMode)
  if (processingMode !== 'local-first') return payload
  let persisted = await ratchetHandoverPrivacyFamily(db, {
    handoverId: job.handover_id,
    runningJobId: job.id,
    workerId,
  })
  if (!persisted) throw new Error('Lost handover job lease.')
  return persisted
}

export async function predictWithLocalPrivacy(
  localPrivacy: Pick<LocalPrivacyClient, 'withDeidentifiedText'>,
  options: Pick<Required<WorkerOptions>, 'dspyBaseUrl' | 'dspyTimeoutMs' | 'dspySharedSecret'>,
  transcript: string,
  predictor: typeof predict = predict,
  audit?: LocalPrivacyAuditSink,
  denyTerms: readonly LocalPrivacyDenyTerm[] = [],
  provenanceResolver: typeof fetchDspyProvenance = fetchDspyProvenance,
  allowedFindings: readonly LocalPrivacyAllowedFinding[] = [],
): Promise<{ checklist: unknown; sbar: unknown; unknownFacts: unknown }> {
  let provenance = audit
    ? await provenanceResolver(
        options.dspyBaseUrl,
        options.dspyTimeoutMs,
        options.dspySharedSecret,
      )
    : null
  return localPrivacy.withDeidentifiedText(transcript, async (safeTranscript, deidentification) => {
    let applied = applyLocalPrivacyExceptionsFailClosed(transcript, deidentification, allowedFindings)
    let paths = ['/predict/checklist', '/predict/sbar', '/predict/unknown-fact'] as const
    let prepared = audit ? await audit.prepare({
      contextType: 'handover-dspy',
      sourceText: transcript,
      deidentification: {
        ...deidentification,
        text: applied.text,
        openMedText: safeTranscript,
      },
      appliedExceptions: applied.appliedExceptions,
      requests: paths.map((path) => ({
        targetKind: 'dspy-predict' as const,
        targetName: path,
        provider: provenance!.provider,
        model: provenance!.model,
      })),
    }) : null
    let invoke = (path: typeof paths[number]) => {
      let operation = async () => {
        let prediction = await predictor(
          options.dspyBaseUrl,
          path,
          applied.text,
          options.dspyTimeoutMs,
          options.dspySharedSecret,
        )
        if (provenance) assertDspyPredictionProvenance(prediction, provenance, path)
        return prediction
      }
      if (!audit || !prepared) return operation()
      let cloudRequest = prepared.requests.find((candidate) => candidate.targetName === path)
      if (!cloudRequest) throw new Error(`Local privacy audit request was not prepared for ${path}.`)
      return audit.dispatch(cloudRequest.id, operation)
    }
    let [checklist, sbar, unknownFacts] = await Promise.all(paths.map(invoke))
    return { checklist, sbar, unknownFacts }
  }, { denyTerms })
}

async function processJob(
  runtime: DataRuntime,
  job: HandoverJobRow,
  options: Required<WorkerOptions>,
  services: WorkerServices,
): Promise<void> {
  let workerId = job.locked_by ?? options.workerId
  if (!await acquireHandoverJobLease(runtime.db, {
    handoverId: job.handover_id,
    jobId: job.id,
    lockMs: options.lockMs,
  })) {
    await failHandoverJob(runtime.db, {
      handoverId: job.handover_id,
      jobId: job.id,
      workerId,
      errorMessage: 'Another handover job is active.',
    })
    return
  }

  let lostLease = false
  let heartbeat = setInterval(() => {
    void refreshHandoverJobLease(runtime.db, {
      handoverId: job.handover_id,
      jobId: job.id,
      workerId,
      lockMs: options.lockMs,
    })
      .then((renewed) => { if (!renewed) lostLease = true })
      .catch(() => {
        // A storage/network exception does not prove another worker owns the
        // lease. The next heartbeat can still renew it; only an authoritative
        // false response means ownership has been lost.
        console.warn('handover job heartbeat temporarily unavailable', { jobId: job.id })
      })
  }, Math.max(1_000, Math.floor(options.lockMs / 3)))
  heartbeat.unref()

  let completed = false
  let stage: ProcessingStage = 'queue'
  let activeTranscriptionRunId: string | null = null
  let activeAnalysisRunId: string | null = null
  try {
    await closeAbandonedRuns(runtime.db, job, workerId)
    let handover = await loadHandoverWork(runtime.db, job, workerId)
    let transcript = handover.transcript
    let metadata = handover.transcriptionMetadata
    let analysisInput: TranscriptionResult | null = null
    let analysisRetry = job.payload.retryFrom === 'analysis'
    let processingMode = processingModeForJob(
      job.payload,
      process.env,
      handover.privacyModeFloor,
    )
    job.payload = await persistProcessingModeRatchet(
      runtime.db,
      job,
      workerId,
      processingMode,
    )
    let deletionRequired = processingMode === 'local-first'

    if (job.kind === 'extend' && !analysisRetry && job.payload.rollbackTranscript === undefined) {
      job.payload = await captureExtensionRollback(runtime.db, job, workerId, handover)
    }
    let priorPrivacyTranscript = job.kind === 'extend'
      ? payloadString(job.payload.rollbackTranscript) ?? (analysisRetry ? null : handover.transcript)
      : null
    let priorPrivacyCleanupDependencies = processingMode === 'local-first' && priorPrivacyTranscript
      ? await listHandoverPrivacyAudioCleanupDependenciesForTranscript(runtime.db, {
          handoverId: job.handover_id,
          transcript: priorPrivacyTranscript,
        })
      : []

    if (analysisRetry) {
      if (!transcript || !metadata || isStoredTranscriptMocked(transcript, handover.rawTranscriptionMetadata)) {
        throw new Error('No usable transcript is available for analysis retry.')
      }
      await scheduleProcessedAudioCleanup(
        services.audioRetention,
        job,
        payloadString(job.payload.audioBlobKey),
        deletionRequired,
      )
      analysisInput = job.kind === 'extend'
        ? sliceTranscriptionTail(
          { transcript, metadata },
          job.payload.retrySegmentCount ?? 0,
        )
        : { transcript, metadata }
      await markHandoverAnalysing(runtime.db, job, workerId)
    } else {
      stage = 'transcription'
      activeTranscriptionRunId = runId('transcription', job)
      await beginTranscriptionRun(
        runtime.db,
        job,
        workerId,
        activeTranscriptionRunId,
        providerForTranscription(job, handover.audioBlobKey),
      )
      let transcribed = await transcribeForJob(handover, job, services, processingMode)
      if (lostLease) throw new Error('Lost handover job lease.')
      await completeTranscriptionRun(
        runtime.db,
        job,
        workerId,
        activeTranscriptionRunId,
        transcribed.result,
        transcribed.newSegmentCount,
        transcribed.processedAudioBlobKey,
        deletionRequired,
      )
      await scheduleProcessedAudioCleanup(
        services.audioRetention,
        job,
        transcribed.processedAudioBlobKey,
        deletionRequired,
      )
      activeTranscriptionRunId = null
      transcript = transcribed.result.transcript
      metadata = transcribed.result.metadata
      analysisInput = transcribed.analysisInput
    }

    if (!analysisInput) throw new Error('No usable transcript is available for analysis.')
    let existingAnalysis = job.kind === 'extend'
      ? await loadExistingAnalysisResult(runtime.db, job, workerId)
      : null
    // A recommenced recording is only a continuation when there is a durable
    // completed analysis to extend. If the original analysis failed, the
    // retained transcript still contains both the original handover and the
    // appended recording, so analyse that complete transcript as a fresh
    // handover instead of producing an orphaned one-sentence continuation.
    let analysisMode: 'full' | 'continuation' = job.kind === 'extend' && existingAnalysis
      ? 'continuation'
      : 'full'
    if (job.kind === 'extend' && !existingAnalysis) {
      if (!transcript || !metadata) throw new Error('No complete transcript is available for full analysis recovery.')
      analysisInput = { transcript, metadata }
    }
    let currentPrivacyCleanupDependencies = payloadString(job.payload.manualTranscript)
      ? []
      : job.payload.audioCleanupDependencies ?? [{
          jobId: payloadString(job.payload.audioCleanupJobId) ?? job.id,
          revision: job.revision,
        }]
    if (!fullAnalysisRecoveryPrivacyCleanupIsProvable({
      processingMode,
      analysisMode,
      jobKind: job.kind,
      analysisRetry,
      hasRollbackTranscript: typeof job.payload.rollbackTranscript === 'string',
      priorTranscript: priorPrivacyTranscript,
      priorDependencies: priorPrivacyCleanupDependencies,
      rollbackEngine: record(job.payload.rollbackTranscriptionMetadata)?.engine,
    })) {
      throw new Error('The previous transcript recording cleanup provenance is unavailable for full analysis recovery.')
    }
    let privacyCleanupDependencyKeys = new Set<string>()
    let privacyCleanupDependencies = [
      ...(analysisMode === 'full' ? priorPrivacyCleanupDependencies : []),
      ...currentPrivacyCleanupDependencies,
    ].filter((dependency) => {
      let key = JSON.stringify([dependency.jobId, dependency.revision])
      if (privacyCleanupDependencyKeys.has(key)) return false
      privacyCleanupDependencyKeys.add(key)
      return true
    })
    if (processingMode === 'local-first' && analysisMode === 'full') {
      await confirmRequiredPrivacyAudioCleanupDependencies(
        services.audioRetention,
        privacyCleanupDependencies,
      )
    }
    let privacyDenyTerms = processingMode === 'local-first'
      ? handoverPrivacyDenyTerms(
          handover,
          [existingAnalysis],
          await loadPriorPrivacyDenyTerms(runtime.db, job, workerId),
        )
      : []
    let privacyAllowedFindings = processingMode === 'local-first'
      ? await listActiveHandoverPrivacyExceptions(runtime.db, job.handover_id)
      : []

    stage = 'analysis'
    activeAnalysisRunId = runId('analysis', job)
    await beginAnalysisRun(runtime.db, job, workerId, activeAnalysisRunId)
    let localPrivacyAudit = processingMode === 'local-first'
      ? createLocalPrivacyAuditSink(runtime.db, {
          handoverId: job.handover_id,
          jobId: job.id,
          analysisRunId: activeAnalysisRunId,
          revision: job.revision,
          audioCleanupDependencies: privacyCleanupDependencies,
        })
      : undefined
    let dspy = processingMode === 'local-first'
      ? await predictWithLocalPrivacy(
          services.localPrivacy,
          options,
          analysisInput.transcript,
          predict,
          localPrivacyAudit,
          privacyDenyTerms,
          fetchDspyProvenance,
          privacyAllowedFindings,
        )
      : {
          checklist: predict(options.dspyBaseUrl, '/predict/checklist', analysisInput.transcript, options.dspyTimeoutMs, options.dspySharedSecret),
          sbar: predict(options.dspyBaseUrl, '/predict/sbar', analysisInput.transcript, options.dspyTimeoutMs, options.dspySharedSecret),
          unknownFacts: predict(options.dspyBaseUrl, '/predict/unknown-fact', analysisInput.transcript, options.dspyTimeoutMs, options.dspySharedSecret),
        }
    let analysisRequester = processingMode === 'local-first'
      ? createDeidentifiedAnalysisRequester(
          services.localPrivacy,
          services.analysisRequester,
          {
            audit: localPrivacyAudit,
            model: process.env.OPENAI_MODEL?.trim() || 'gpt-5.5',
            denyTerms: privacyDenyTerms,
            allowedFindings: privacyAllowedFindings,
          },
        )
      : services.analysisRequester
    let incomingAnalysis = await analyzeHandover({
      transcript: analysisInput.transcript,
      handover: {
        title: handover.title,
        contextType: handover.contextType,
        direction: handover.direction,
        sourceDepartment: handover.sourceDepartment,
        destinationDepartment: handover.destinationDepartment,
        participants: handover.participants,
        linkedPatientKey: handover.linkedPatientKey,
        linkedPatientDisplayName: handover.linkedPatientDisplayName,
        linkedPatientLocation: handover.linkedPatientLocation,
        notes: analysisMode === 'continuation'
          ? continuationNotes(handover.notes, existingAnalysis)
          : handover.notes,
      },
      transcriptionMetadata: analysisInput.metadata,
      dspy,
      analysisMode,
    }, { requester: analysisRequester })
    if (lostLease) throw new Error('Lost handover job lease.')
    await persistCompletedAnalysis(runtime.db, job, workerId, activeAnalysisRunId, incomingAnalysis, handover)
    activeAnalysisRunId = null
    try {
      await reconcileStoredHandoverSheetWithSbar(runtime.db, {
        handoverId: job.handover_id,
        requester: processingMode === 'local-first'
          ? createDeidentifiedSheetReconciliationRequester(
              services.localPrivacy,
              services.sheetReconciliationRequester,
              {
                audit: localPrivacyAudit,
                model: process.env.OPENAI_MODEL?.trim() || 'gpt-5.5',
                denyTerms: handoverPrivacyDenyTerms(
                  handover,
                  [existingAnalysis, incomingAnalysis],
                  privacyDenyTerms,
                ),
                allowedFindings: privacyAllowedFindings,
              },
            )
          : services.sheetReconciliationRequester,
      })
    } catch (error) {
      // The completed handover remains authoritative when this optional
      // enrichment provider is unavailable. A later extension can reconcile
      // the same canonical row without corrupting the saved analysis.
      console.warn('handover sheet SBAR reconciliation failed', {
        handoverId: job.handover_id,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      })
    }
    completed = true
  } catch (error) {
    let errorMessage = safeProcessingError(error, stage)
    let diagnostic = processingFailureDiagnostic(error, stage)
    console.error('handover job processing failed', {
      handoverId: job.handover_id,
      jobId: job.id,
      revision: job.revision,
      ...diagnostic,
    })
    if (activeTranscriptionRunId) {
      await markRunFailed(runtime.db, 'transcription_runs', activeTranscriptionRunId, job, workerId, errorMessage, diagnostic)
    }
    if (activeAnalysisRunId) {
      await markRunFailed(runtime.db, 'analysis_runs', activeAnalysisRunId, job, workerId, errorMessage, diagnostic)
    }
    await failHandoverJob(runtime.db, {
      handoverId: job.handover_id,
      jobId: job.id,
      workerId,
      errorMessage,
    })
  } finally {
    clearInterval(heartbeat)
    if (completed) {
      await clearHandoverJobLease(runtime.db, { handoverId: job.handover_id, jobId: job.id })
    }
  }
}

async function processNextAudioCleanup(
  retention: SuccessfulTranscriptionAudioRetention,
): Promise<void> {
  try {
    let result = await retention.processNext()
    if (result.status === 'delete-failed') {
      console.warn('A scheduled audio cleanup attempt failed and will be retried.')
    }
  } catch {
    // Cleanup is an independent durable queue. A transient database or object
    // storage failure must not stop handover processing; the claim expires and
    // a later worker loop reclaims it.
    console.warn('The scheduled audio cleanup queue is temporarily unavailable.')
  }
}

export async function runWorker(runtime = createDataRuntime(), input: WorkerOptions = {}): Promise<void> {
  let options = resolveWorkerOptions(input)
  let audioStorage = createConfiguredAudioStorage()
  let localPrivacy = createLocalPrivacyClient({ storage: audioStorage, env: process.env })
  let services: WorkerServices = {
    transcription: createTranscriptionService({
      transcribeAudio: (input) => localPrivacy.transcribeAudio(input),
      env: process.env,
    }),
    localPrivacy,
    audioNoise: createAudioNoiseAnalyzer({ storage: audioStorage, env: process.env }),
    audioRetention: createSuccessfulTranscriptionAudioRetention({
      db: runtime.db,
      storage: audioStorage,
      env: process.env,
      workerId: `${options.workerId}:audio-cleanup`,
      lockMs: options.lockMs,
    }),
    analysisRequester: createConfiguredOpenAIAnalysisRequester(process.env),
    sheetReconciliationRequester: createConfiguredOpenAIHandoverSheetReconciliationRequester(process.env),
  }
  await runtime.ready()
  let queueWakeup = createHandoverJobQueueWakeup(runtime.pool.options, {
    onUnavailable(error) {
      console.warn('PostgreSQL queue notifications are unavailable; timed polling remains active.', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      })
    },
  })
  await queueWakeup.start()
  let stopping = false
  let stop = () => {
    stopping = true
    void queueWakeup.close()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  console.log(`handover-job-worker started workerId=${options.workerId}`)
  try {
    while (!stopping) {
      let job = await claimNextHandoverJob(runtime.db, { workerId: options.workerId, lockMs: options.lockMs })
      if (job) await processJob(runtime, job, options, services)
      await processNextAudioCleanup(services.audioRetention)
      if (!job) await queueWakeup.wait(options.pollMs)
    }
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await queueWakeup.close()
    await releaseWorkerLeases(runtime.db, options.workerId)
    await runtime.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWorker().catch((error) => { console.error(error); process.exitCode = 1 })
}
