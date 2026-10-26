import path from 'node:path'
import { Readable } from 'node:stream'

import { z } from 'zod'

import {
  buildTranscriptSegments,
  createEmptyAudioNoiseMetrics,
  type TranscriptionResult,
} from '../data/transcription.ts'
import type { UploadStorage } from '../data/upload-storage.ts'
import type { AnalysisRequester } from './handover-analysis.server.ts'
import type { HandoverSheetReconciliationRequester } from './handover-sheet-reconciliation.server.ts'
import type { LocalPrivacyAuditSink } from './local-privacy-audit.server.ts'
import type { ShiftPrioritisationRequester } from './shift-prioritisation.server.ts'

type Environment = Readonly<Record<string, string | undefined>>

const transcriptionResponseSchema = z.object({
  text: z.string().trim().min(1),
  language: z.literal('en'),
  duration_ms: z.number().int().nonnegative(),
  model: z.string().trim().min(1).max(200),
  backend: z.enum(['mlx', 'nemo', 'cpp']),
  transcription_elapsed_ms: z.number().int().nonnegative(),
})

const piiFindingSchema = z.object({
  original_text: z.string(),
  label: z.string().trim().min(1).max(200),
  entity_type: z.string().trim().min(1).max(200),
  canonical_label: z.string().trim().min(1).max(200).nullable(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1).nullable(),
  replacement_text: z.string(),
  action: z.string().trim().min(1).max(100).nullable(),
  sources: z.array(z.string().trim().min(1).max(200)).max(100),
  threshold: z.number().min(0).max(1).nullable(),
})

const deidentificationResponseSchema = z.object({
  text: z.string(),
  token: z.string().trim().min(1).max(500),
  replacement_count: z.number().int().nonnegative(),
  pii_findings: z.array(piiFindingSchema).max(100_000),
  model: z.string().trim().min(1).max(500),
  openmed_version: z.string().trim().min(1).max(100),
  model_revision: z.string().trim().min(1).max(200).nullable(),
  backend: z.string().trim().min(1).max(100).nullable(),
  method: z.string().trim().min(1).max(100),
  policy: z.string().trim().min(1).max(200),
  offline: z.boolean(),
  smart_merging: z.boolean(),
  safety_sweep: z.boolean(),
}).superRefine((value, context) => {
  if (value.replacement_count !== value.pii_findings.length) {
    context.addIssue({
      code: 'custom',
      path: ['replacement_count'],
      message: 'Replacement count must match the PII findings.',
    })
  }
})

const reidentificationResponseSchema = z.object({ value: z.unknown() })

const audioSuffixes = new Set(['.bin', '.flac', '.m4a', '.mp3', '.mp4', '.ogg', '.wav', '.webm'])

export type LocalDeidentification = {
  text: string
  token: string
  replacementCount: number
  piiFindings: Array<{
    originalText: string
    label: string
    entityType: string
    canonicalLabel: string | null
    start: number
    end: number
    confidence: number | null
    replacementText: string
    action: string | null
    sources: string[]
    threshold: number | null
  }>
  modelId: string
  sdkVersion: string
  modelRevision: string | null
  backend: string | null
  method: string
  policy: string
  offline: boolean
  smartMerging: boolean
  safetySweep: boolean
}

export type LocalDeidentificationAudit = Omit<LocalDeidentification, 'token'>

export type LocalPrivacyDenyTerm = {
  term: string
  label: string
}

export type LocalPrivacyDeidentificationOptions = {
  denyTerms?: readonly LocalPrivacyDenyTerm[]
}

export type LocalPrivacyAllowedFinding = {
  exceptionId: string
  normalizedText: string
  canonicalLabel: string
}

export type AppliedLocalPrivacyException = {
  exceptionId: string
  findingOrdinal: number
}

export class LocalPrivacyExceptionApplicationError extends Error {
  readonly code = 'LOCAL_PRIVACY_EXCEPTION_APPLICATION_FAILED'

  constructor() {
    super('The approved personal-information exception could not be applied safely.')
    this.name = 'LocalPrivacyExceptionApplicationError'
  }
}

type LocalPrivacyExceptionFinding = Pick<
  LocalDeidentificationAudit['piiFindings'][number],
  'originalText' | 'replacementText' | 'canonicalLabel' | 'start' | 'end'
> & Partial<Omit<
  LocalDeidentificationAudit['piiFindings'][number],
  'originalText' | 'replacementText' | 'canonicalLabel' | 'start' | 'end'
>>

export type LocalPrivacyExceptionMap = Partial<Omit<LocalDeidentificationAudit, 'text' | 'piiFindings'>> & {
  text: string
  piiFindings: readonly LocalPrivacyExceptionFinding[]
}

/** Canonical-equivalence normalization only; matching remains case/space exact. */
function normalizeLocalPrivacyExceptionText(value: string): string {
  if (typeof value !== 'string') throw new TypeError('Privacy exception text must be a string.')
  let normalized = value.normalize('NFKC')
  if (!normalized.trim() || normalized.length > 512) {
    throw new TypeError('Privacy exception text is invalid.')
  }
  return normalized
}

function normalizeLocalPrivacyExceptionCanonicalLabel(value: string): string {
  if (typeof value !== 'string') throw new TypeError('Privacy exception canonical label must be a string.')
  let normalized = value.normalize('NFKC')
  if (!normalized.trim() || normalized.length > 200) {
    throw new TypeError('Privacy exception canonical label is invalid.')
  }
  return normalized
}

function allowedFindingKey(originalText: string, canonicalLabel: string): string {
  return JSON.stringify([
    normalizeLocalPrivacyExceptionText(originalText),
    normalizeLocalPrivacyExceptionCanonicalLabel(canonicalLabel),
  ])
}

function candidateFindingKey(originalText: string, canonicalLabel: string): string | undefined {
  try {
    return allowedFindingKey(originalText, canonicalLabel)
  } catch {
    // Stored exceptions are bounded and validated when written. A future model
    // finding outside those bounds cannot match one, but it must not prevent the
    // rest of the transcript from remaining masked and reaching analysis.
    return undefined
  }
}

/**
 * Applies persistent exceptions only after proving OpenMed's replacement map
 * round-trips byte-for-byte to the supplied source. This deliberately does not
 * reconstruct from finding spans, so overlapping/ambiguous findings fail
 * closed instead of risking a different cloud-bound string.
 */
export function applyLocalPrivacyExceptions(
  sourceText: string,
  deidentification: LocalPrivacyExceptionMap,
  exceptions: readonly LocalPrivacyAllowedFinding[],
): {
  text: string
  appliedExceptions: AppliedLocalPrivacyException[]
} {
  if (exceptions.length === 0 || deidentification.piiFindings.length === 0) {
    return { text: deidentification.text, appliedExceptions: [] }
  }

  let byKey = new Map<string, LocalPrivacyAllowedFinding>()
  for (let exception of exceptions) {
    if (typeof exception.exceptionId !== 'string' || !exception.exceptionId.trim()) {
      throw new TypeError('Privacy exception identifier is invalid.')
    }
    let key = JSON.stringify([
      normalizeLocalPrivacyExceptionText(exception.normalizedText),
      normalizeLocalPrivacyExceptionCanonicalLabel(exception.canonicalLabel),
    ])
    byKey.set(key, exception)
  }

  let findings = deidentification.piiFindings
    .map((finding, ordinal) => ({ finding, ordinal }))
    .sort((left, right) =>
      left.finding.start - right.finding.start
      || left.finding.end - right.finding.end
      || left.ordinal - right.ordinal)
  let matches = findings.map(({ finding }) => {
    if (finding.canonicalLabel == null) return undefined
    let key = candidateFindingKey(finding.originalText, finding.canonicalLabel)
    return key == null ? undefined : byKey.get(key)
  })
  if (!matches.some(Boolean)) return { text: deidentification.text, appliedExceptions: [] }

  let maskedCursor = 0
  let restored = ''
  let effective = ''
  for (let [index, { finding }] of findings.entries()) {
    if (!finding.replacementText) throw new LocalPrivacyExceptionApplicationError()
    let replacementStart = deidentification.text.indexOf(finding.replacementText, maskedCursor)
    if (replacementStart < maskedCursor) throw new LocalPrivacyExceptionApplicationError()
    let prefix = deidentification.text.slice(maskedCursor, replacementStart)
    restored += prefix + finding.originalText
    effective += prefix + (matches[index] ? finding.originalText : finding.replacementText)
    maskedCursor = replacementStart + finding.replacementText.length
  }
  restored += deidentification.text.slice(maskedCursor)
  effective += deidentification.text.slice(maskedCursor)
  if (restored !== sourceText) throw new LocalPrivacyExceptionApplicationError()

  return {
    text: effective,
    appliedExceptions: findings.flatMap(({ ordinal }, index) => {
      let exception = matches[index]
      return exception ? [{ exceptionId: exception.exceptionId, findingOrdinal: ordinal }] : []
    }),
  }
}

/**
 * A later OpenMed model may emit a replacement map that cannot safely restore
 * a previously approved value. Keep OpenMed's complete masked output in that
 * case and record no applied exception; an append-only preference must never
 * force raw text through an ambiguous map or permanently block analysis.
 */
export function applyLocalPrivacyExceptionsFailClosed(
  sourceText: string,
  deidentification: LocalPrivacyExceptionMap,
  exceptions: readonly LocalPrivacyAllowedFinding[],
): ReturnType<typeof applyLocalPrivacyExceptions> {
  try {
    return applyLocalPrivacyExceptions(sourceText, deidentification, exceptions)
  } catch (error) {
    if (error instanceof LocalPrivacyExceptionApplicationError) {
      return { text: deidentification.text, appliedExceptions: [] }
    }
    throw error
  }
}

// One shift sheet may contain 5,000 patients and each authoritative identity
// contributes a patient key plus a display name. The local service uses a
// bounded linear-time exact matcher for this full contract.
export const maximumLocalPrivacyDenyTerms = 10_000

// This request contract mirrors REQUIRED_PROTECTED_ENTITY_TYPES in the local
// privacy service. Allowed clinical-context labels must not become deny terms.
const protectedLocalPrivacyDenyTermLabels: ReadonlySet<string> = new Set([
  'ACCOUNT_NUMBER',
  'API_KEY',
  'BUILDING_NUMBER',
  'CREDIT_CARD',
  'CVV',
  'DATE_OF_BIRTH',
  'EMAIL',
  'FIRST_NAME',
  'GPS_COORDINATES',
  'ID_NUM',
  'LAST_NAME',
  'MIDDLE_NAME',
  'OTHER',
  'PASSWORD',
  'PERSON',
  'PHONE',
  'PIN',
  'SSN',
  'STREET_ADDRESS',
  'USERNAME',
  'ZIPCODE',
])

export function isProtectedLocalPrivacyDenyTermLabel(value: string): boolean {
  return protectedLocalPrivacyDenyTermLabels.has(value)
}

/**
 * Keep request-scoped OpenMed recognizer input bounded and deterministic. The
 * terms themselves remain local and are never added to application logs.
 */
export function normalizeLocalPrivacyDenyTerms(
  values: readonly LocalPrivacyDenyTerm[],
): LocalPrivacyDenyTerm[] {
  let normalized: LocalPrivacyDenyTerm[] = []
  let seen = new Set<string>()
  for (let value of values) {
    let term = typeof value?.term === 'string' ? value.term.trim() : ''
    let label = typeof value?.label === 'string' ? value.label.trim() : ''
    if (!term || term.length > 512 || !label || label.length > 200) {
      throw new TypeError('Local privacy deny terms are invalid.')
    }
    if (seen.has(term)) continue
    if (normalized.length >= maximumLocalPrivacyDenyTerms) {
      throw new RangeError('Local privacy deny terms exceed the request limit.')
    }
    seen.add(term)
    normalized.push({ term, label })
  }
  return normalized
}

export interface LocalPrivacyClient {
  transcribeAudio(input: {
    audioBlobKey: string
    originalFilename?: string | null
  }): Promise<TranscriptionResult>
  deidentify(
    text: string,
    options?: LocalPrivacyDeidentificationOptions,
  ): Promise<LocalDeidentification>
  reidentify<T>(token: string, value: T): Promise<T>
  release(token: string): Promise<void>
  withDeidentifiedText<T>(
    text: string,
    operation: (safeText: string, deidentification: LocalDeidentificationAudit) => Promise<T>,
    options?: LocalPrivacyDeidentificationOptions,
  ): Promise<T>
}

export class LocalPrivacyServiceError extends Error {
  readonly code = 'LOCAL_PRIVACY_SERVICE_FAILED'

  constructor(readonly operation: 'transcription' | 'deidentification' | 'reidentification' | 'release') {
    super(`Local privacy ${operation} failed.`)
    this.name = 'LocalPrivacyServiceError'
  }
}

export type LocalPrivacyOptions = {
  baseUrl: string
  sharedSecret: string
  timeoutMs: number
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value == null || value === '') return fallback
  let parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`)
  return parsed
}

function isLoopbackHostname(hostname: string): boolean {
  let normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

export function resolveLocalPrivacyOptions(env: Environment = process.env): LocalPrivacyOptions {
  let baseUrl = new URL(env.LOCAL_PRIVACY_API_URL?.trim() || 'http://127.0.0.1:8789')
  let sharedSecret = env.LOCAL_PRIVACY_SHARED_SECRET?.trim() ?? ''
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('LOCAL_PRIVACY_API_URL must not contain credentials, query parameters, or fragments.')
  }
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error('LOCAL_PRIVACY_API_URL must use HTTP or HTTPS.')
  }
  if (
    baseUrl.protocol !== 'https:'
    && !isLoopbackHostname(baseUrl.hostname)
    && env.LOCAL_PRIVACY_ALLOW_INSECURE_REMOTE !== 'true'
  ) {
    throw new Error('A remote LOCAL_PRIVACY_API_URL must use HTTPS.')
  }
  if (!isLoopbackHostname(baseUrl.hostname) && !sharedSecret) {
    throw new Error('A remote LOCAL_PRIVACY_API_URL requires LOCAL_PRIVACY_SHARED_SECRET.')
  }
  return {
    baseUrl: baseUrl.toString().replace(/\/+$/, ''),
    sharedSecret,
    // Covers the service's bounded 15-minute admission wait plus a bounded
    // five-minute OpenMed operation (or the 15-minute Omi transcription).
    timeoutMs: positiveInteger(env.LOCAL_PRIVACY_TIMEOUT_MS, 1_260_000, 'LOCAL_PRIVACY_TIMEOUT_MS'),
  }
}

function audioSuffix(filename: string | null | undefined): string {
  let suffix = path.extname(filename?.trim() ?? '').toLowerCase()
  return audioSuffixes.has(suffix) ? suffix : '.bin'
}

function deidentificationForAudit(
  deidentification: LocalDeidentification,
): LocalDeidentificationAudit {
  let { token: _token, ...audit } = deidentification
  return audit
}

async function jsonResponse<T>(response: Response, schema: z.ZodType<T>, operation: LocalPrivacyServiceError['operation']): Promise<T> {
  if (!response.ok) throw new LocalPrivacyServiceError(operation)
  try {
    return schema.parse(await response.json())
  } catch (error) {
    if (error instanceof LocalPrivacyServiceError) throw error
    throw new LocalPrivacyServiceError(operation)
  }
}

/**
 * Loopback/private client for the process that is allowed to handle raw audio
 * and replacement mappings. Callers receive only an opaque, short-lived token;
 * the replacement mapping never enters the Remix worker process.
 */
export function createLocalPrivacyClient(input: {
  storage: Pick<UploadStorage, 'getStream'>
  env?: Environment
  fetch?: typeof globalThis.fetch
}): LocalPrivacyClient {
  let options = resolveLocalPrivacyOptions(input.env)
  let fetchImplementation = input.fetch ?? globalThis.fetch

  function endpoint(pathname: string): URL {
    return new URL(pathname.replace(/^\/+/, ''), `${options.baseUrl}/`)
  }

  function headers(contentType = 'application/json'): Headers {
    let value = new Headers({ 'Content-Type': contentType })
    if (options.sharedSecret) value.set('x-local-privacy-token', options.sharedSecret)
    return value
  }

  async function request<T>(
    pathname: string,
    init: RequestInit,
    schema: z.ZodType<T>,
    operation: LocalPrivacyServiceError['operation'],
  ): Promise<T> {
    let response: Response
    try {
      response = await fetchImplementation(endpoint(pathname), {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs),
      })
    } catch {
      throw new LocalPrivacyServiceError(operation)
    }
    return jsonResponse(response, schema, operation)
  }

  let client: LocalPrivacyClient = {
    async transcribeAudio({ audioBlobKey, originalFilename }) {
      let source = await input.storage.getStream(audioBlobKey)
      let requestHeaders = headers('application/octet-stream')
      requestHeaders.set('x-audio-suffix', audioSuffix(originalFilename))
      let response = await request('/v1/transcriptions', {
        method: 'POST',
        headers: requestHeaders,
        body: Readable.toWeb(source) as ReadableStream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }, transcriptionResponseSchema, 'transcription')
      let segments = buildTranscriptSegments(response.text).map((segment) => ({
        ...segment,
        confidence: null,
        speaker: 'unknown' as const,
      }))
      let syntheticDurationMs = segments.at(-1)?.endMs ?? 0
      return {
        transcript: response.text,
        metadata: {
          engine: `${response.model}:${response.backend}`,
          mocked: false,
          language: response.language,
          durationMs: response.duration_ms || syntheticDurationMs,
          transcriptionElapsedMs: response.transcription_elapsed_ms,
          interruptionSignals: [],
          noiseSignals: [],
          audioNoise: createEmptyAudioNoiseMetrics(),
          segments,
        },
      }
    },

    async deidentify(text, deidentificationOptions = {}) {
      let denyTerms = normalizeLocalPrivacyDenyTerms(deidentificationOptions.denyTerms ?? [])
      let value = await request('/v1/deidentifications', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          text,
          ...(denyTerms.length ? { deny_terms: denyTerms } : {}),
        }),
      }, deidentificationResponseSchema, 'deidentification')
      return {
        text: value.text,
        token: value.token,
        replacementCount: value.replacement_count,
        piiFindings: value.pii_findings.map((finding) => ({
          originalText: finding.original_text,
          label: finding.label,
          entityType: finding.entity_type,
          canonicalLabel: finding.canonical_label,
          start: finding.start,
          end: finding.end,
          confidence: finding.confidence,
          replacementText: finding.replacement_text,
          action: finding.action,
          sources: finding.sources,
          threshold: finding.threshold,
        })),
        modelId: value.model,
        sdkVersion: value.openmed_version,
        modelRevision: value.model_revision,
        backend: value.backend,
        method: value.method,
        policy: value.policy,
        offline: value.offline,
        smartMerging: value.smart_merging,
        safetySweep: value.safety_sweep,
      }
    },

    async reidentify<T>(token: string, value: T): Promise<T> {
      let restored = await request('/v1/reidentifications', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ token, value }),
      }, reidentificationResponseSchema, 'reidentification')
      return restored.value as T
    },

    async release(token) {
      let response: Response
      try {
        response = await fetchImplementation(
          endpoint(`/v1/deidentifications/${encodeURIComponent(token)}`),
          {
            method: 'DELETE',
            headers: headers(),
            redirect: 'error',
            signal: AbortSignal.timeout(options.timeoutMs),
          },
        )
      } catch {
        throw new LocalPrivacyServiceError('release')
      }
      if (response.status !== 204) throw new LocalPrivacyServiceError('release')
    },

    async withDeidentifiedText<T>(
      text: string,
      operation: (safeText: string, deidentification: LocalDeidentificationAudit) => Promise<T>,
      deidentificationOptions: LocalPrivacyDeidentificationOptions = {},
    ): Promise<T> {
      let deidentified = await client.deidentify(text, deidentificationOptions)
      let consumed = false
      try {
        let result = await operation(deidentified.text, deidentificationForAudit(deidentified))
        let restored = await client.reidentify(deidentified.token, result)
        consumed = true
        return restored
      } finally {
        if (!consumed) {
          await client.release(deidentified.token).catch(() => {
            // The local vault expires mappings independently. Never replace the
            // primary processing error with a cleanup error or log token data.
            console.warn('Local replacement mapping cleanup was not confirmed.')
          })
        }
      }
    },
  }
  return client
}

export function createDeidentifiedAnalysisRequester(
  localPrivacy: LocalPrivacyClient,
  upstream: AnalysisRequester,
  options: {
    audit?: LocalPrivacyAuditSink
    model?: string
    denyTerms?: readonly LocalPrivacyDenyTerm[]
    allowedFindings?: readonly LocalPrivacyAllowedFinding[]
  } = {},
): AnalysisRequester {
  return {
    async request(request) {
      let { privacyDenyTerms, ...upstreamRequest } = request
      return localPrivacy.withDeidentifiedText(request.input, async (safeInput, deidentification) => {
        let applied = applyLocalPrivacyExceptionsFailClosed(
          request.input,
          deidentification,
          options.allowedFindings ?? [],
        )
        let operation = () => upstream.request({ ...upstreamRequest, input: applied.text })
        if (!options.audit) return operation()
        let prepared = await options.audit.prepare({
          contextType: 'handover-openai',
          sourceText: request.input,
          deidentification: {
            ...deidentification,
            text: applied.text,
            openMedText: safeInput,
          },
          appliedExceptions: applied.appliedExceptions,
          requests: [{
            targetKind: 'openai-responses',
            targetName: request.schemaName,
            provider: 'openai',
            model: options.model?.trim() || 'gpt-5.5',
          }],
        })
        let cloudRequest = prepared.requests[0]
        if (!cloudRequest) throw new Error('Local privacy audit request was not prepared.')
        return options.audit.dispatch(cloudRequest.id, operation)
      }, { denyTerms: [...(options.denyTerms ?? []), ...(privacyDenyTerms ?? [])] })
    },
  }
}

export function createDeidentifiedSheetReconciliationRequester(
  localPrivacy: LocalPrivacyClient,
  upstream: HandoverSheetReconciliationRequester,
  options: {
    audit?: LocalPrivacyAuditSink
    model?: string
    denyTerms?: readonly LocalPrivacyDenyTerm[]
    allowedFindings?: readonly LocalPrivacyAllowedFinding[]
  } = {},
): HandoverSheetReconciliationRequester {
  return {
    async request(request) {
      return localPrivacy.withDeidentifiedText(request.input, async (safeInput, deidentification) => {
        let applied = applyLocalPrivacyExceptionsFailClosed(
          request.input,
          deidentification,
          options.allowedFindings ?? [],
        )
        let operation = () => upstream.request({ ...request, input: applied.text })
        if (!options.audit) return operation()
        let prepared = await options.audit.prepare({
          contextType: 'handover-sheet-reconciliation',
          sourceText: request.input,
          deidentification: {
            ...deidentification,
            text: applied.text,
            openMedText: safeInput,
          },
          appliedExceptions: applied.appliedExceptions,
          requests: [{
            targetKind: 'openai-responses',
            targetName: request.schemaName,
            provider: 'openai',
            model: options.model?.trim() || 'gpt-5.5',
          }],
        })
        let cloudRequest = prepared.requests[0]
        if (!cloudRequest) throw new Error('Local privacy audit request was not prepared.')
        return options.audit.dispatch(cloudRequest.id, operation)
      }, { denyTerms: options.denyTerms })
    },
  }
}

export function createDeidentifiedShiftPrioritisationRequester(
  localPrivacy: LocalPrivacyClient,
  upstream: ShiftPrioritisationRequester,
  options: {
    audit?: LocalPrivacyAuditSink
    model?: string
    denyTerms?: readonly LocalPrivacyDenyTerm[]
  } = {},
): ShiftPrioritisationRequester {
  return (request) => localPrivacy.withDeidentifiedText(request.input, async (safeInput, deidentification) => {
    let operation = () => upstream({ ...request, input: safeInput })
    if (!options.audit) return operation()
    let prepared = await options.audit.prepare({
      contextType: 'shift-prioritisation',
      sourceText: request.input,
      deidentification,
      requests: [{
        targetKind: 'openai-responses',
        targetName: 'shift_prioritisation',
        provider: 'openai',
        model: options.model?.trim() || 'gpt-5.5',
      }],
    })
    let cloudRequest = prepared.requests[0]
    if (!cloudRequest) throw new Error('Local privacy audit request was not prepared.')
    return options.audit.dispatch(cloudRequest.id, operation)
  }, { denyTerms: options.denyTerms })
}
