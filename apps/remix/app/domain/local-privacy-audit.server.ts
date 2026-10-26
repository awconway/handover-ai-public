import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'

import { sql, type Database } from 'remix/data-table'

const localPrivacyAuditContextTypes = [
  'handover-dspy',
  'handover-openai',
  'handover-sheet-reconciliation',
  'shift-prioritisation',
] as const

export type LocalPrivacyAuditContextType = (typeof localPrivacyAuditContextTypes)[number]
export type LocalPrivacyAuditTargetKind = 'dspy-predict' | 'openai-responses'

export type LocalPrivacyAuditFindingInput = {
  originalText: string
  label: string
  entityType: string
  canonicalLabel: string | null
  /** Unicode-codepoint offset into LocalPrivacyAuditPrepareInput.sourceText. */
  start: number
  /** Exclusive Unicode-codepoint offset into LocalPrivacyAuditPrepareInput.sourceText. */
  end: number
  confidence: number | null
  replacementText: string
  action: string | null
  sources: string[]
  threshold: number | null
}

/**
 * Structural counterpart of the local privacy client's de-identification value.
 * It deliberately does not import that module, which lets the client depend on
 * this sink later without creating a server-module cycle.
 */
export type LocalDeidentificationAuditInput = {
  text: string
  /** Unmodified OpenMed output before any clinician-approved exceptions. */
  openMedText?: string
  replacementCount: number
  piiFindings: LocalPrivacyAuditFindingInput[]
  modelId: string
  sdkVersion: string
  modelRevision?: string | null
  backend?: string | null
  method: string
  policy: string
  offline: boolean
  smartMerging: boolean
  safetySweep: boolean
}

export type LocalPrivacyAuditRequestPlan = {
  targetKind: LocalPrivacyAuditTargetKind
  targetName: string
  provider: string
  model: string
}

export type LocalPrivacyAuditPrepareInput = {
  contextType: LocalPrivacyAuditContextType
  sourceText: string
  deidentification: LocalDeidentificationAuditInput
  appliedExceptions?: Array<{ exceptionId: string; findingOrdinal: number }>
  requests: LocalPrivacyAuditRequestPlan[]
}

export type PreparedLocalPrivacyAudit = {
  auditId: string
  requests: Array<{ id: string; targetName: string }>
}

export type LocalPrivacyAuditContext = {
  handoverId?: string | null
  shiftId?: string | null
  jobId?: string | null
  analysisRunId?: string | null
  revision?: number | null
  initiatedByUserId?: string | null
  /** Exact successful-transcription cleanup proofs for this source text. */
  audioCleanupDependencies?: ReadonlyArray<{ jobId: string; revision: number }>
}

export type LocalPrivacyAuditSink = {
  prepare(input: LocalPrivacyAuditPrepareInput): Promise<PreparedLocalPrivacyAudit>
  dispatch<T>(requestId: string, operation: () => Promise<T>): Promise<T>
}

export class LocalPrivacyAuditValidationError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'LocalPrivacyAuditValidationError'
  }
}

export class LocalPrivacyAuditStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LocalPrivacyAuditStateError'
  }
}

type NormalizedContext = {
  handoverId: string | null
  shiftId: string | null
  jobId: string | null
  analysisRunId: string | null
  revision: number | null
  initiatedByUserId: string | null
  audioCleanupDependencies: Array<{ jobId: string; revision: number }>
}

type NormalizedFinding = LocalPrivacyAuditFindingInput & {
  sources: string[]
}

type NormalizedPrepareInput = Omit<LocalPrivacyAuditPrepareInput, 'deidentification' | 'requests'> & {
  deidentification: Omit<LocalDeidentificationAuditInput, 'piiFindings'> & {
    modelRevision: string | null
    backend: string | null
    openMedText: string
    piiFindings: NormalizedFinding[]
  }
  appliedExceptions: Array<{ exceptionId: string; findingOrdinal: number }>
  requests: LocalPrivacyAuditRequestPlan[]
}

function optionalIdentifier(value: string | null | undefined, name: string): string | null {
  if (value == null) return null
  if (typeof value !== 'string' || !value.trim()) {
    throw new LocalPrivacyAuditValidationError(`${name} must be a non-empty string when supplied.`)
  }
  return value.trim()
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LocalPrivacyAuditValidationError(`${name} must be a non-empty string.`)
  }
  return value.trim()
}

function exactString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new LocalPrivacyAuditValidationError(`${name} must be a string.`)
  }
  return value
}

function nullableRequiredString(value: unknown, name: string): string | null {
  if (value == null) return null
  return requiredString(value, name)
}

function positiveInteger(value: number | null | undefined, name: string): number | null {
  if (value == null) return null
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LocalPrivacyAuditValidationError(`${name} must be a positive integer when supplied.`)
  }
  return value
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LocalPrivacyAuditValidationError(`${name} must be a non-negative integer.`)
  }
  return value
}

function probability(value: unknown, name: string): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new LocalPrivacyAuditValidationError(`${name} must be between 0 and 1 when supplied.`)
  }
  return value
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new LocalPrivacyAuditValidationError(`${name} must be a boolean.`)
  }
  return value
}

function normalizeContext(context: LocalPrivacyAuditContext): NormalizedContext {
  let rawCleanupDependencies = context.audioCleanupDependencies ?? []
  if (!Array.isArray(rawCleanupDependencies) || rawCleanupDependencies.length > 256) {
    throw new LocalPrivacyAuditValidationError('audioCleanupDependencies must be a bounded array.')
  }
  let cleanupDependencyKeys = new Set<string>()
  let audioCleanupDependencies = rawCleanupDependencies.map((dependency, index) => {
    if (!dependency || typeof dependency !== 'object') {
      throw new LocalPrivacyAuditValidationError(`audioCleanupDependencies[${index}] must be an object.`)
    }
    let normalized = {
      jobId: optionalIdentifier(dependency.jobId, `audioCleanupDependencies[${index}].jobId`),
      revision: positiveInteger(dependency.revision, `audioCleanupDependencies[${index}].revision`),
    }
    if (!normalized.jobId || !normalized.revision) {
      throw new LocalPrivacyAuditValidationError('Audio cleanup dependencies require a job and revision.')
    }
    let key = JSON.stringify([normalized.jobId, normalized.revision])
    if (cleanupDependencyKeys.has(key)) {
      throw new LocalPrivacyAuditValidationError('Audio cleanup dependencies must be unique.')
    }
    cleanupDependencyKeys.add(key)
    return { jobId: normalized.jobId, revision: normalized.revision }
  })
  let normalized: NormalizedContext = {
    handoverId: optionalIdentifier(context.handoverId, 'handoverId'),
    shiftId: optionalIdentifier(context.shiftId, 'shiftId'),
    jobId: optionalIdentifier(context.jobId, 'jobId'),
    analysisRunId: optionalIdentifier(context.analysisRunId, 'analysisRunId'),
    revision: positiveInteger(context.revision, 'revision'),
    initiatedByUserId: optionalIdentifier(context.initiatedByUserId, 'initiatedByUserId'),
    audioCleanupDependencies,
  }
  if (Boolean(normalized.handoverId) === Boolean(normalized.shiftId)) {
    throw new LocalPrivacyAuditValidationError('Exactly one handoverId or shiftId audit owner is required.')
  }
  if (normalized.shiftId && (normalized.jobId || normalized.analysisRunId || normalized.revision)) {
    throw new LocalPrivacyAuditValidationError('Job, analysis-run, and revision context require a handover owner.')
  }
  if (normalized.audioCleanupDependencies.length > 0 && !normalized.handoverId) {
    throw new LocalPrivacyAuditValidationError('Audio cleanup dependencies require a handover audit owner.')
  }
  return normalized
}

function normalizeFinding(
  value: LocalPrivacyAuditFindingInput,
  ordinal: number,
  sourceCodepoints: string[],
): NormalizedFinding {
  if (!value || typeof value !== 'object') {
    throw new LocalPrivacyAuditValidationError(`piiFindings[${ordinal}] must be an object.`)
  }
  let start = nonNegativeInteger(value.start, `piiFindings[${ordinal}].start`)
  let end = nonNegativeInteger(value.end, `piiFindings[${ordinal}].end`)
  if (end <= start || end > sourceCodepoints.length) {
    throw new LocalPrivacyAuditValidationError(`piiFindings[${ordinal}] has invalid Unicode-codepoint offsets.`)
  }
  let originalText = exactString(value.originalText, `piiFindings[${ordinal}].originalText`)
  if (sourceCodepoints.slice(start, end).join('') !== originalText) {
    throw new LocalPrivacyAuditValidationError(`piiFindings[${ordinal}].originalText does not match its source span.`)
  }
  if (!Array.isArray(value.sources) || value.sources.some((source) => typeof source !== 'string' || !source.trim())) {
    throw new LocalPrivacyAuditValidationError(`piiFindings[${ordinal}].sources must contain only non-empty strings.`)
  }
  return {
    originalText,
    label: requiredString(value.label, `piiFindings[${ordinal}].label`),
    entityType: requiredString(value.entityType, `piiFindings[${ordinal}].entityType`),
    canonicalLabel: nullableRequiredString(value.canonicalLabel, `piiFindings[${ordinal}].canonicalLabel`),
    start,
    end,
    confidence: probability(value.confidence, `piiFindings[${ordinal}].confidence`),
    replacementText: exactString(value.replacementText, `piiFindings[${ordinal}].replacementText`),
    action: nullableRequiredString(value.action, `piiFindings[${ordinal}].action`),
    sources: value.sources.map((source) => source.trim()),
    threshold: probability(value.threshold, `piiFindings[${ordinal}].threshold`),
  }
}

function normalizePrepareInput(input: LocalPrivacyAuditPrepareInput, context: NormalizedContext): NormalizedPrepareInput {
  if (!localPrivacyAuditContextTypes.includes(input.contextType)) {
    throw new LocalPrivacyAuditValidationError('Unsupported local privacy audit contextType.')
  }
  if (input.contextType === 'shift-prioritisation' ? !context.shiftId : !context.handoverId) {
    throw new LocalPrivacyAuditValidationError('The audit contextType does not match its owner.')
  }
  let sourceText = exactString(input.sourceText, 'sourceText')
  let deidentification = input.deidentification
  if (!deidentification || typeof deidentification !== 'object') {
    throw new LocalPrivacyAuditValidationError('deidentification must be an object.')
  }
  if (!Array.isArray(deidentification.piiFindings)) {
    throw new LocalPrivacyAuditValidationError('deidentification.piiFindings must be an array.')
  }
  let replacementCount = nonNegativeInteger(deidentification.replacementCount, 'deidentification.replacementCount')
  if (replacementCount !== deidentification.piiFindings.length) {
    throw new LocalPrivacyAuditValidationError('replacementCount must equal the number of PII findings.')
  }
  let sourceCodepoints = [...sourceText]
  let piiFindings = deidentification.piiFindings.map((finding, ordinal) =>
    normalizeFinding(finding, ordinal, sourceCodepoints))
  let rawAppliedExceptions = input.appliedExceptions ?? []
  if (!Array.isArray(rawAppliedExceptions)) {
    throw new LocalPrivacyAuditValidationError('appliedExceptions must be an array.')
  }
  if (rawAppliedExceptions.length > piiFindings.length) {
    throw new LocalPrivacyAuditValidationError('appliedExceptions cannot exceed the number of PII findings.')
  }
  if (rawAppliedExceptions.length > 0 && !context.handoverId) {
    throw new LocalPrivacyAuditValidationError('Personal-information exceptions require a handover audit owner.')
  }
  let appliedOrdinals = new Set<number>()
  let appliedExceptions = rawAppliedExceptions.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new LocalPrivacyAuditValidationError(`appliedExceptions[${index}] must be an object.`)
    }
    let exceptionId = requiredString(value.exceptionId, `appliedExceptions[${index}].exceptionId`)
    let findingOrdinal = nonNegativeInteger(value.findingOrdinal, `appliedExceptions[${index}].findingOrdinal`)
    if (findingOrdinal >= piiFindings.length || appliedOrdinals.has(findingOrdinal)) {
      throw new LocalPrivacyAuditValidationError('Applied exception finding ordinals must be unique and in range.')
    }
    if (!piiFindings[findingOrdinal]?.canonicalLabel) {
      throw new LocalPrivacyAuditValidationError('An applied exception requires an OpenMed canonical label.')
    }
    appliedOrdinals.add(findingOrdinal)
    return { exceptionId, findingOrdinal }
  })

  if (!Array.isArray(input.requests) || input.requests.length === 0) {
    throw new LocalPrivacyAuditValidationError('At least one cloud request plan is required.')
  }
  let expectedTargetKind: LocalPrivacyAuditTargetKind = input.contextType === 'handover-dspy'
    ? 'dspy-predict'
    : 'openai-responses'
  let seenTargets = new Set<string>()
  let requests = input.requests.map((request, index): LocalPrivacyAuditRequestPlan => {
    if (!request || typeof request !== 'object' || request.targetKind !== expectedTargetKind) {
      throw new LocalPrivacyAuditValidationError(`requests[${index}].targetKind does not match the audit context.`)
    }
    let normalized = {
      targetKind: request.targetKind,
      targetName: requiredString(request.targetName, `requests[${index}].targetName`),
      provider: requiredString(request.provider, `requests[${index}].provider`),
      model: requiredString(request.model, `requests[${index}].model`),
    }
    let targetKey = `${normalized.targetKind}\u0000${normalized.targetName}`
    if (seenTargets.has(targetKey)) {
      throw new LocalPrivacyAuditValidationError('Cloud request targets must be unique within one audit.')
    }
    seenTargets.add(targetKey)
    return normalized
  })

  return {
    contextType: input.contextType,
    sourceText,
    deidentification: {
      text: exactString(deidentification.text, 'deidentification.text'),
      openMedText: exactString(deidentification.openMedText ?? deidentification.text, 'deidentification.openMedText'),
      replacementCount,
      piiFindings,
      modelId: requiredString(deidentification.modelId, 'deidentification.modelId'),
      sdkVersion: requiredString(deidentification.sdkVersion, 'deidentification.sdkVersion'),
      modelRevision: nullableRequiredString(deidentification.modelRevision, 'deidentification.modelRevision'),
      backend: nullableRequiredString(deidentification.backend, 'deidentification.backend'),
      method: requiredString(deidentification.method, 'deidentification.method'),
      policy: requiredString(deidentification.policy, 'deidentification.policy'),
      offline: booleanValue(deidentification.offline, 'deidentification.offline'),
      smartMerging: booleanValue(deidentification.smartMerging, 'deidentification.smartMerging'),
      safetySweep: booleanValue(deidentification.safetySweep, 'deidentification.safetySweep'),
    },
    appliedExceptions,
    requests,
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function appendOnlyId(kind: 'audit' | 'request', at: Date): string {
  let timePrefix = at.toISOString().replace(/\D/g, '')
  return `local-privacy-${kind}-${timePrefix}-${randomUUID()}`
}

const safeErrorTypes = new Set([
  'AbortError',
  'AggregateError',
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'APIError',
  'ApplicationError',
  'AuthenticationError',
  'BadRequestError',
  'ConflictError',
  'DspyPredictionError',
  'Error',
  'InternalServerError',
  'LocalPrivacyServiceError',
  'NotFoundError',
  'OpenAIAnalysisRequestError',
  'PermissionDeniedError',
  'RangeError',
  'RateLimitError',
  'ReferenceError',
  'SyntaxError',
  'TimeoutError',
  'TypeError',
  'URIError',
  'UnknownError',
  'UnprocessableEntityError',
  'ZodError',
])

function safeErrorType(error: unknown): string {
  let candidate = error instanceof Error ? error.name : 'UnknownError'
  return safeErrorTypes.has(candidate) ? candidate : 'ApplicationError'
}

function changed(result: { rows?: Record<string, unknown>[] }): boolean {
  return (result.rows?.length ?? 0) === 1
}

function contextOwnership(context: NormalizedContext) {
  return sql`
    audit.handover_id is not distinct from ${context.handoverId}
    and audit.shift_id is not distinct from ${context.shiftId}
    and audit.job_id is not distinct from ${context.jobId}
    and audit.analysis_run_id is not distinct from ${context.analysisRunId}
    and audit.revision is not distinct from ${context.revision}
    and audit.initiated_by_user_id is not distinct from ${context.initiatedByUserId}
  `
}

export function createLocalPrivacyAuditSink(
  db: Database,
  rawContext: LocalPrivacyAuditContext,
): LocalPrivacyAuditSink {
  let context = normalizeContext(rawContext)

  return {
    async prepare(rawInput) {
      let input = normalizePrepareInput(rawInput, context)
      let createdAt = new Date()
      let auditId = appendOnlyId('audit', createdAt)
      let requests = input.requests.map((request) => ({
        ...request,
        id: appendOnlyId('request', createdAt),
      }))
      let sourceSha256 = digest(input.sourceText)
      let deidentifiedSha256 = digest(input.deidentification.text)
      let openMedDeidentifiedSha256 = digest(input.deidentification.openMedText)

      await db.transaction(async (tx) => {
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
            replacement_count, created_at
          ) values (
            ${auditId}, ${input.contextType}, ${context.handoverId}, ${context.shiftId},
            ${context.jobId}, ${context.analysisRunId}, ${context.revision},
            ${context.initiatedByUserId}, ${input.sourceText}, ${sourceSha256},
            ${Buffer.byteLength(input.sourceText, 'utf8')}, ${input.deidentification.text},
            ${deidentifiedSha256}, ${Buffer.byteLength(input.deidentification.text, 'utf8')},
            ${input.deidentification.modelId}, ${input.deidentification.modelRevision},
            ${input.deidentification.openMedText}, ${openMedDeidentifiedSha256},
            ${Buffer.byteLength(input.deidentification.openMedText, 'utf8')},
            ${input.appliedExceptions.length},
            ${input.deidentification.sdkVersion}, ${input.deidentification.backend},
            ${input.deidentification.method}, ${input.deidentification.policy},
            ${input.deidentification.offline}, ${input.deidentification.smartMerging},
            ${input.deidentification.safetySweep}, ${input.deidentification.replacementCount},
            ${createdAt}
          )
        `)

        for (let [ordinal, finding] of input.deidentification.piiFindings.entries()) {
          await tx.exec(sql`
            insert into local_privacy_findings(
              audit_id, ordinal, label, entity_type, canonical_label, original_text,
              replacement_text, start_codepoint, end_codepoint, confidence,
              threshold, sources, action
            ) values (
              ${auditId}, ${ordinal}, ${finding.label}, ${finding.entityType},
              ${finding.canonicalLabel}, ${finding.originalText}, ${finding.replacementText},
              ${finding.start}, ${finding.end}, ${finding.confidence}, ${finding.threshold},
              ${JSON.stringify(finding.sources)}::jsonb, ${finding.action}
            )
          `)
        }

        for (let applied of input.appliedExceptions) {
          let finding = input.deidentification.piiFindings[applied.findingOrdinal]!
          let linked = await tx.exec(sql`
            insert into local_privacy_audit_applied_exceptions(
              audit_id, finding_ordinal, exception_id, applied_at
            )
            select ${auditId}, ${applied.findingOrdinal}, exception.id, ${createdAt}
            from local_privacy_exceptions exception
            join handovers handover on handover.id = ${context.handoverId}
            where exception.id = ${applied.exceptionId}
              and exception.handover_family_id = coalesce(handover.source_handover_id, handover.id)
              and exception.normalized_text = ${finding.originalText.normalize('NFKC')}
              and exception.canonical_label = ${finding.canonicalLabel!.normalize('NFKC')}
            returning exception_id
          `)
          if (!changed(linked)) {
            throw new LocalPrivacyAuditStateError('An applied personal-information exception is not valid for this audit.')
          }
        }

        for (let dependency of context.audioCleanupDependencies) {
          await tx.exec(sql`
            insert into local_privacy_audit_audio_cleanup_dependencies(
              audit_id, cleanup_job_id, cleanup_revision
            ) values (
              ${auditId}, ${dependency.jobId}, ${dependency.revision}
            )
          `)
        }

        for (let request of requests) {
          await tx.exec(sql`
            insert into local_privacy_cloud_requests(
              id, audit_id, target_kind, target_name, provider, model, status,
              prepared_at, updated_at
            ) values (
              ${request.id}, ${auditId}, ${request.targetKind}, ${request.targetName},
              ${request.provider}, ${request.model}, 'prepared', ${createdAt}, ${createdAt}
            )
          `)
        }
      })

      return {
        auditId,
        requests: requests.map(({ id, targetName }) => ({ id, targetName })),
      }
    },

    async dispatch<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
      let id = requiredString(requestId, 'requestId')
      if (typeof operation !== 'function') {
        throw new LocalPrivacyAuditValidationError('operation must be a function.')
      }
      let started = await db.exec(sql`
        update local_privacy_cloud_requests request set
          status = 'dispatching', dispatch_started_at = now(), updated_at = now()
        where request.id = ${id} and request.status = 'prepared'
          and exists (
            select 1 from local_privacy_audits audit
            where audit.id = request.audit_id and ${contextOwnership(context)}
          )
        returning request.id
      `)
      if (!changed(started)) {
        throw new LocalPrivacyAuditStateError('The cloud request is not prepared for this audit context.')
      }

      let result: T
      try {
        // Deliberately outside a database transaction: this operation may be a
        // slow or ambiguous network request.
        result = await operation()
      } catch (error) {
        let failed: { rows?: Record<string, unknown>[] }
        try {
          failed = await db.exec(sql`
            update local_privacy_cloud_requests set
              status = 'failed', error_type = ${safeErrorType(error)}, failed_at = now(),
              completed_at = null, updated_at = now()
            where id = ${id} and status = 'dispatching'
            returning id
          `)
        } catch (persistenceError) {
          throw new LocalPrivacyAuditStateError('Could not persist the failed cloud request outcome.', {
            cause: persistenceError,
          })
        }
        if (!changed(failed)) {
          throw new LocalPrivacyAuditStateError('Could not persist the failed cloud request outcome.', {
            cause: error,
          })
        }
        throw error
      }

      let completed = await db.exec(sql`
        update local_privacy_cloud_requests set
          status = 'completed', completed_at = now(), failed_at = null,
          error_type = null, updated_at = now()
        where id = ${id} and status = 'dispatching'
        returning id
      `)
      if (!changed(completed)) {
        throw new LocalPrivacyAuditStateError('Could not persist the completed cloud request outcome.')
      }
      return result
    },
  }
}
