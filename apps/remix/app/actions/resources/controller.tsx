import { nanoid } from 'nanoid'
import * as s from 'remix/data-schema'
import * as f from 'remix/data-schema/form-data'
import { Auth } from 'remix/middleware/auth'
import { createController, type Middleware } from 'remix/router'
import { Session } from 'remix/session'

import {
  extractHandoverSheet,
  getHandoverForUser,
  HandoverSheetExtractionError,
  listProcessingHandoversForUser,
  purgeExpiredUsabilityAnalytics,
  recordUsabilityEvents,
  recordUsabilitySession,
  UploadValidationError,
} from '../../data/index.ts'
import { normalizePatientKey, patientIdentityKey } from '../../data/patient-identity.ts'
import { DataRuntimeKey } from '../../middleware/data.ts'
import { HandoverProcessingChangesKey } from '../../middleware/processing-events.ts'
import { publicFormMiddleware } from '../../middleware/forms.ts'
import { TemporaryUploadFiles } from '../../middleware/uploads.ts'
import { requireUser } from '../../middleware/auth.ts'
import {
  reviewHref,
  routes,
  sanitizeAnalyticsRoute as sanitizeRoute,
} from '../../routes.ts'
import { fileUpload } from '../upload-input.ts'

const analyticsSchema = f.object({ events: f.field(s.string()) })

export const sanitizeAnalyticsRoute = sanitizeRoute

function sanitizedReferrer(value: string | null): string | null {
  if (!value) return null
  try { return sanitizeAnalyticsRoute(new URL(value).pathname) } catch { return sanitizeAnalyticsRoute(value) }
}

function analyticsRetentionDays(): number {
  let configured = Number.parseInt(process.env.USABILITY_ANALYTICS_RETENTION_DAYS ?? '90', 10)
  return Number.isSafeInteger(configured) ? Math.min(3650, Math.max(0, configured)) : 90
}

const analyticsPurgeIntervalMs = 24 * 60 * 60 * 1_000
let nextAnalyticsPurgeAt = 0
let analyticsPurgeInFlight: Promise<void> | null = null

function scheduleAnalyticsPurge(
  db: Parameters<typeof purgeExpiredUsabilityAnalytics>[0],
  now: Date,
  retentionDays: number,
) {
  if (retentionDays === 0 || analyticsPurgeInFlight || now.getTime() < nextAnalyticsPurgeAt) return
  nextAnalyticsPurgeAt = now.getTime() + analyticsPurgeIntervalMs
  analyticsPurgeInFlight = purgeExpiredUsabilityAnalytics(
    db,
    new Date(now.getTime() - retentionDays * 86_400_000),
  ).then(() => undefined).catch((error: unknown) => {
    console.error('Could not purge expired usability analytics.', error)
  }).finally(() => {
    analyticsPurgeInFlight = null
  })
}

type AnalyticsViewport = { width: number; height: number }

function analyticsViewport(metadata: Record<string, unknown>): AnalyticsViewport | null {
  let width = metadata.viewportWidth, height = metadata.viewportHeight
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width: Math.min(10_000, Math.trunc(width)), height: Math.min(10_000, Math.trunc(height)) }
}

/** Privacy-reviewed, content-free properties retained for usability reports. */
export function analyticsProperties(metadata: Record<string, unknown>) {
  let stringKeys = ['workflow', 'studyTask', 'studyTaskId', 'step', 'outcome', 'reason', 'state', 'mode', 'method', 'metric', 'errorCategory', 'errorName'] as const
  let properties: Record<string, string | number | boolean | null> = Object.fromEntries(stringKeys.flatMap((key) => typeof metadata[key] === 'string' ? [[key, metadata[key].slice(0, 120)]] : []))
  if (typeof metadata.studyTask === 'string' && properties.studyTaskId == null) properties.studyTaskId = metadata.studyTask
  if (typeof metadata.action === 'string') properties.action = sanitizeAnalyticsRoute(metadata.action)
  if (typeof metadata.path === 'string') properties.path = sanitizeAnalyticsRoute(metadata.path)
  if (typeof metadata.source === 'string') properties.source = sanitizeAnalyticsSource(metadata.source)
  if (typeof metadata.prevented === 'boolean') properties.prevented = metadata.prevented
  if (typeof metadata.nextRoute === 'string') properties.nextRoute = sanitizeAnalyticsRoute(metadata.nextRoute)
  if (typeof metadata.referrerPath === 'string') properties.referrerPath = sanitizeAnalyticsRoute(metadata.referrerPath)
  properties.sandbox = Boolean(metadata.sandbox)
  return properties
}

function sanitizeAnalyticsSource(value: string) {
  if (value.startsWith('/')) return sanitizeAnalyticsRoute(value)
  return /^[a-z0-9:_-]{1,80}$/i.test(value) ? value : 'unknown'
}

function sanitizeAnalyticsTargetIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let normalized = value.trim().slice(0, 120)
  if (!/^[a-zA-Z0-9:_-]+$/.test(normalized)) return null
  let dynamicPrefix = [
    'patient-card',
    'patient-task-row',
    'handover-row',
    'shift-card',
    'sheet-field',
    'task-toggle',
    'task-edit',
    'task-delete',
    'task-due-picker',
    'task-reminder',
    'task-status',
    'checklist-toggle',
    'new-task-due-picker-day',
  ].find((prefix) => normalized.startsWith(`${prefix}-`))
  if (dynamicPrefix) return `${dynamicPrefix}-:id`
  if (/\d{4}-\d{2}-\d{2}/.test(normalized)) return normalized.replace(/\d{4}-\d{2}-\d{2}.*/, ':id')
  if (/[a-f0-9]{8}-[a-f0-9-]{27,}/i.test(normalized)) return normalized.replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/i, ':id')
  return normalized
}

export function deriveAnalyticsDevice(userAgent: string, viewport: AnalyticsViewport | null) {
  let ua = userAgent.toLowerCase()
  let platform = /iphone|ipad|ipod/.test(ua) ? 'ios'
    : /android/.test(ua) ? 'android'
      : /windows/.test(ua) ? 'windows'
        : /macintosh|mac os x/.test(ua) ? 'macos'
          : /linux/.test(ua) ? 'linux' : 'unknown'
  let deviceType = /ipad|tablet|android(?!.*mobile)/.test(ua) ? 'tablet'
    : /mobile|iphone|ipod/.test(ua) ? 'mobile'
      : viewport && viewport.width < 768 ? 'mobile'
        : viewport && viewport.width < 1024 ? 'tablet' : 'desktop'
  return { deviceType, platform }
}

const protectSheetExtraction = requireUser()
const resourceBodyAuth: Middleware = (context, next) =>
  context.url.pathname === routes.resources.extractHandoverSheet.href()
    ? protectSheetExtraction(context, next)
    : next()

function json(value: unknown, init?: ResponseInit) {
  let headers = new Headers(init?.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'private, no-store')
  return new Response(JSON.stringify(value), { ...init, headers })
}

function identity(context: any) {
  let auth = context.get(Auth)
  return auth.ok ? auth.identity : null
}

function eventStreamResponse(context: any, userId: string): Response {
  let encoder = new TextEncoder()
  let source = context.get(HandoverProcessingChangesKey)
  let db = context.get(DataRuntimeKey).db
  let cleanup = () => {}
  let stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let active = true
      let closed = false
      let pending = Promise.resolve()
      let unsubscribe = () => {}
      let heartbeat: ReturnType<typeof setInterval> | undefined
      let close = () => {
        if (closed) return
        closed = true
        active = false
        if (heartbeat) clearInterval(heartbeat)
        unsubscribe()
        try { controller.close() } catch { /* The client may already be gone. */ }
      }
      let send = (event: 'ready' | 'processing', value: Record<string, unknown>) => {
        if (!active) return
        try {
          controller.enqueue(encoder.encode(
            `${event === 'ready' ? 'retry: 2000\n' : ''}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`,
          ))
        } catch {
          close()
        }
      }
      let reconcile = () => send('ready', {})
      unsubscribe = source.subscribe((handoverId: string | null) => {
        if (handoverId === null) {
          reconcile()
          return
        }
        pending = pending.then(async () => {
          let handover = await getHandoverForUser(db, handoverId, userId)
          if (handover) send('processing', { id: handover.id })
        }).catch(() => {
          // The periodic client reconciliation remains authoritative when a
          // transient lookup fails; keep this long-lived stream open.
        })
      })
      heartbeat = setInterval(() => {
        if (!active) return
        try { controller.enqueue(encoder.encode(': keep-alive\n\n')) }
        catch { close() }
      }, 15_000)
      heartbeat.unref?.()
      cleanup = close
      context.request.signal.addEventListener('abort', close, { once: true })
      reconcile()
      if (context.request.signal.aborted) close()
    },
    cancel() {
      cleanup()
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'private, no-cache, no-transform',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function processingHref(handover: { id: string; shift_id: string | null }) {
  return reviewHref({ shiftId: handover.shift_id, handoverId: handover.id, reviewTab: 'details' })
}

const processingReadinessKeys = [
  'overview',
  'patients',
  'actions',
  'communication',
  'checklist',
  'recommence',
  'riskSignals',
  'sbarEvidence',
  'summary',
  'uncertainty',
] as const

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return null }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * A content-free signal for progressive analysis availability. It deliberately
 * contains no title, transcript, patient identity, model output, or provider
 * error; the browser only needs to know that server-renderable sections changed.
 */
function processingReadinessSignal(value: unknown): string {
  let readiness = object(object(value)?.analysisReadiness)
  return processingReadinessKeys.map((key) => readiness?.[key] === true ? '1' : '0').join('')
}

function processingUpdatedAt(value: Date | string): string {
  let date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

function processingPatientIdentityKeys(handover: {
  linked_patient_key: string | null
  linked_patient_display_name?: string | null
  linked_patient_location?: string | null
  patient_keys?: string[]
  analysis?: unknown
}) {
  let keys = new Set<string>()
  let addReference = (reference: {
    key?: string | null
    displayName?: string | null
    location?: string | null
  }) => {
    let storedKey = normalizePatientKey(reference.key ?? '')
    if (storedKey) keys.add(storedKey)
    let identityKey = patientIdentityKey(reference)
    if (identityKey) keys.add(normalizePatientKey(identityKey))
  }
  addReference({
    key: handover.linked_patient_key,
    displayName: handover.linked_patient_display_name,
    location: handover.linked_patient_location,
  })
  for (let key of handover.patient_keys ?? []) addReference({ key })
  let patients = object(handover.analysis)?.patients
  if (Array.isArray(patients)) {
    for (let candidate of patients) {
      let patient = object(candidate)
      if (!patient) continue
      addReference({
        key: typeof patient.patientKey === 'string' ? patient.patientKey : null,
        displayName: typeof patient.displayName === 'string' ? patient.displayName : null,
        location: typeof patient.location === 'string' ? patient.location : null,
      })
    }
  }
  return keys
}

function processingScopeRelevant(
  handover: {
    id: string
    shift_id: string | null
    source_shift_id?: string | null
    linked_patient_key: string | null
    linked_patient_display_name?: string | null
    linked_patient_location?: string | null
    patient_keys?: string[]
    analysis?: unknown
  },
  pathname: string,
): boolean {
  let segments = pathname.split('/').filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment) } catch { return segment }
  })
  if (
    segments.length === 0
    || pathname === routes.workspace.shiftSelection.href()
    || pathname === routes.workspace.inbox.href()
  ) return true
  if (segments[0] === 'individual' && segments.length === 1) return handover.shift_id === null
  let handoverIndex = segments.indexOf('handover')
  if (handoverIndex >= 0 && segments[handoverIndex + 1]) {
    return segments[handoverIndex + 1] === handover.id
  }
  if (
    segments[0] !== 'shift'
    || !segments[1]
    || (handover.shift_id !== segments[1] && handover.source_shift_id !== segments[1])
  ) return false
  let patientIndex = segments.indexOf('patients')
  if (patientIndex >= 0 && segments[patientIndex + 1]) {
    let patientKey = normalizePatientKey(segments[patientIndex + 1]!)
    return processingPatientIdentityKeys(handover).has(patientKey)
  }
  return true
}

function processingItem(handover: {
  id: string
  shift_id: string | null
  source_shift_id?: string | null
  linked_patient_key: string | null
  linked_patient_display_name?: string | null
  linked_patient_location?: string | null
  patient_keys?: string[]
  processing_status: string
  version: number
  updated_at: Date | string
  analysis: unknown
}, pathname = routes.workspace.home.href()) {
  return {
    id: handover.id,
    status: handover.processing_status,
    href: processingHref(handover),
    revision: handover.version,
    updatedAt: processingUpdatedAt(handover.updated_at),
    readiness: processingReadinessSignal(handover.analysis),
    relevant: processingScopeRelevant(handover, pathname),
  }
}

export default createController(routes.resources, {
  middleware: [resourceBodyAuth, ...publicFormMiddleware],
  actions: {
    async processingAll(context) {
      let current = identity(context)
      if (!current) return json({ error: 'Sign in required' }, { status: 401 })
      let trackedIds = context.url.searchParams.getAll('track')
        .filter((id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id))
        .slice(0, 100)
      let pathname = context.url.searchParams.get('path')
      if (!pathname?.startsWith('/') || pathname.length > 500) pathname = routes.workspace.home.href()
      let handovers = await listProcessingHandoversForUser(
        context.get(DataRuntimeKey).db,
        current.id,
        trackedIds,
      )
      return json({
        items: handovers.map((handover) => processingItem(handover, pathname)),
      })
    },
    async processingEvents(context) {
      let current = identity(context)
      if (!current) return json({ error: 'Sign in required' }, { status: 401 })
      return eventStreamResponse(context, current.id)
    },
    async processing(context) {
      let current = identity(context)
      if (!current) return json({ error: 'Sign in required' }, { status: 401 })
      let handover = await getHandoverForUser(context.get(DataRuntimeKey).db, context.params.handoverId, current.id)
      if (!handover) return json({ error: 'Handover not found' }, { status: 404 })
      return json({
        items: [processingItem(handover)],
      })
    },
    async analytics(context) {
      if (process.env.USABILITY_ANALYTICS_ENABLED?.toLowerCase() === 'false') return new Response(null, { status: 204 })
      let parsed = s.parseSafe(analyticsSchema, context.get(FormData))
      if (!parsed.success || parsed.value.events.length > 100_000) return new Response('Invalid analytics batch.', { status: 400 })
      let raw: unknown
      try { raw = JSON.parse(parsed.value.events) } catch { return new Response('Invalid analytics batch.', { status: 400 }) }
      if (!Array.isArray(raw) || raw.length > 50) return new Response('Invalid analytics batch.', { status: 400 })
      let now = new Date()
      let browserSession = context.get(Session)
      let usabilitySessionId = typeof browserSession.get('usabilitySessionId') === 'string' ? browserSession.get('usabilitySessionId') as string : nanoid()
      browserSession.set('usabilitySessionId', usabilitySessionId)
      let current = identity(context)
      let events = raw.flatMap((value: unknown, index) => {
        if (!value || typeof value !== 'object') return []
        let item = value as Record<string, unknown>
        let eventType = typeof item.type === 'string' ? item.type.slice(0, 80) : 'unknown'
        let route = sanitizeAnalyticsRoute(item.route)
        let metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata as Record<string, unknown> : {}
        let viewport = analyticsViewport(metadata)
        let sequence = typeof metadata.sequence === 'number' ? Math.trunc(metadata.sequence) : index + 1
        let occurredAt = typeof item.at === 'string' && !Number.isNaN(Date.parse(item.at)) ? new Date(item.at) : now
        let targetKeys = ['tagName', 'role', 'name', 'analyticsId', 'testId', 'type', 'textLength'] as const
        let target: Record<string, string | number> = {}
        for (let key of targetKeys) {
          let candidate = metadata[key]
          if (key === 'analyticsId' || key === 'testId' || key === 'name') {
            let sanitized = sanitizeAnalyticsTargetIdentifier(candidate)
            if (sanitized) target[key] = sanitized
            continue
          }
          if (typeof candidate === 'string' || typeof candidate === 'number') target[key] = candidate
        }
        let metrics = Object.fromEntries(['durationMs', 'domInteractiveMs', 'loadMs', 'responseMs', 'viewportWidth', 'viewportHeight', 'count', 'messageLength', 'status', 'value'].flatMap((key) => typeof metadata[key] === 'number' ? [[key, metadata[key]]] : []))
        let properties = analyticsProperties(metadata)
        return [{
          id: nanoid(), usability_session_id: usabilitySessionId, auth_session_id: browserSession.id,
          user_id: current?.id ?? null, event_type: eventType, event_sequence: sequence,
          occurred_at: occurredAt, received_at: now, route, path: route, page_title: '',
          duration_ms: typeof metadata.durationMs === 'number' ? Math.max(0, Math.trunc(metadata.durationMs)) : null,
          viewport,
          target: Object.keys(target).length ? target : null, metrics,
          properties,
          payload: { type: eventType, route },
        }]
      })
      let db = context.get(DataRuntimeKey).db
      let retentionDays = analyticsRetentionDays()
      let initialViewport = events.find((event) => event.viewport)?.viewport ?? null
      let userAgent = context.request.headers.get('user-agent') ?? ''
      scheduleAnalyticsPurge(db, now, retentionDays)
      await recordUsabilitySession(db, {
        id: usabilitySessionId,
        auth_session_id: browserSession.id,
        user_id: current?.id ?? null,
        started_at: now,
        last_seen_at: now,
        ended_at: null,
        entry_path: events[0]?.route ?? '/unknown',
        referrer: sanitizedReferrer(context.request.headers.get('referer')),
        user_agent: userAgent,
        device: deriveAnalyticsDevice(userAgent, initialViewport),
        initial_viewport: initialViewport ?? {},
        metadata: { source: 'remix', retentionDays },
      })
      await recordUsabilityEvents(db, events)
      return new Response(null, { status: 204 })
    },
    async extractHandoverSheet(context) {
      if (!identity(context)) return json({ error: 'Sign in required' }, { status: 401 })
      let upload = fileUpload(context.get(FormData), context.get(TemporaryUploadFiles), 'sheet')
      if (!upload) return json({ error: 'Choose a handover sheet to extract.' }, { status: 400 })
      try {
        return json(await extractHandoverSheet(upload))
      } catch (error) {
        if (error instanceof UploadValidationError || error instanceof HandoverSheetExtractionError) {
          return json({ error: error.message }, { status: error.status })
        }
        console.error(error)
        return json({ error: 'The handover sheet could not be extracted.' }, { status: 500 })
      }
    },
    release() {
      return json({ release: process.env.RELEASE_VERSION ?? 'development', acceptingMutations: process.env.DRAIN_MODE !== 'true' })
    },
  },
})
