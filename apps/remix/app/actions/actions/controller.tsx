import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import * as s from 'remix/data-schema'
import { maxLength, minLength } from 'remix/data-schema/checks'
import * as f from 'remix/data-schema/form-data'
import { Auth } from 'remix/middleware/auth'
import { createController } from 'remix/router'
import { redirect } from 'remix/response/redirect'
import { Session } from 'remix/session'

import {
  attachHandoverAudio,
  allowHandoverPrivacyFindingsForUser,
  collectShiftSheetSourceFileKeys,
  createAssignment,
  createHandover,
  createShift,
  dismissAssignment,
  deleteHandoverAndCollectOrphanedAudioKeys,
  discardFailedHandoverAttempt,
  deleteHandoverTask,
  deleteShift,
  enqueueHandoverJob,
  extendHandover,
  findUnreferencedShiftSheetSourceFileKeys,
  getHandoverForUser,
  getLocalFirstProcessingPreferenceForUser,
  getShiftForUser,
  handoversHaveLocalFirstProcessingHistory,
  handoverTaskPriorities,
  handoverTaskSources,
  handoverTaskStatuses,
  HandoverRecordingUploadConflictError,
  HandoverRecordingUploadGoneError,
  HandoverSheetExtractionError,
  extractHandoverSheet,
  importShiftHandoverSheet,
  lockAudioBlobKeyForReferenceAssignment,
  lockHandoverRecordingUpload,
  recordHandoverRecordingUpload,
  isLocalFirstAudioStorageBackendCompatible,
  resolveEffectiveProcessingMode,
  resolveHandoverRecordingUpload,
  resolveLocalFirstProcessingPolicy,
  reviewShiftSheetPatientField,
  retryFailedHandoverJob,
  setShiftPatientOrder,
  setTaskStatus,
  updateTaskFields,
  addAssignmentToIndividual,
  placeAssignment,
  queueHandoverPrivacyReanalysisForUser,
  updateHandoverChecklistItem,
  updateHandoverReviewMetadata,
  updateHandoverSummaryReviewStatus,
  updateHandoverSummarySection,
  updateShiftPatientDetails,
  createHandoverTask,
  currentPrivacyPolicyVersion,
  consumeProvisionalAudioUploadCleanupInTransaction,
  digestBoundUploadKey,
  enqueueProvisionalAudioUploadCleanup,
  ProvisionalAudioCleanupBusyError,
  ResourceCleanupConflictError,
  sha256UploadFile,
  storeUploadAtKey,
  UploadValidationError,
  type HandoverTaskStatus,
  type StoredUpload,
} from '../../data/index.ts'
import { DataRuntimeKey } from '../../middleware/data.ts'
import { protectedFormMiddleware } from '../../middleware/forms.ts'
import { TemporaryUploadFiles, UploadStores } from '../../middleware/uploads.ts'
import { defaultReviewTab, reviewHref as routeReviewHref, routes, type ReviewTab } from '../../routes.ts'
import { markFrameMutationSuccess } from '../../utils/frame-mutation.ts'
import { safeInternalPath } from '../../utils/internal-path.ts'
import { resolveTaskDueInput } from '../../utils/task-dates.ts'
import {
  createConfiguredRequester as createConfiguredShiftPrioritisationRequester,
  prioritiseShiftBoard,
} from '../../domain/shift-prioritisation.server.ts'
import {
  createDeidentifiedShiftPrioritisationRequester,
  createLocalPrivacyClient,
} from '../../domain/local-privacy.server.ts'
import { createLocalPrivacyAuditSink } from '../../domain/local-privacy-audit.server.ts'
import { fileUpload } from '../upload-input.ts'

const requiredText = (min = 1, max = 500) => s.string().pipe(minLength(min), maxLength(max))
const optionalText = (max = 500) => s.defaulted(s.string().pipe(maxLength(max)), '')
const booleanText = s.defaulted(s.string(), 'false').transform((value) =>
  ['1', 'true', 'on', 'yes'].includes(value.toLowerCase()),
)
const stringList = s.defaulted(s.string(), '[]').transform((value) => {
  try {
    let parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : []
  } catch {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  }
})
const recordingUploadId = s.defaulted(
  s.string().refine(
    (value) => value === '' || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
    'Recording upload identifier must be a UUID.',
  ),
  '',
).transform((value) => value.toLowerCase())

const shiftSchema = f.object({
  title: f.field(requiredText(3, 120)),
  department: f.field(requiredText(2, 80)),
  assignedUserIds: f.field(stringList),
  notes: f.field(optionalText()),
})
const orderSchema = f.object({ patientKeys: f.field(stringList) })
const shiftPatientDetailsSchema = f.object({
  displayName: f.field(requiredText(1, 240)),
  location: f.field(requiredText(1, 120)),
  handoverId: f.field(optionalText(120)),
})
const handoverSchema = f.object({
  title: f.field(requiredText(3, 120)),
  contextType: f.field(requiredText(1, 80)),
  direction: f.field(s.defaulted(s.string(), 'incoming')),
  sourceDepartment: f.field(requiredText(2, 80)),
  destinationDepartment: f.field(optionalText(80)),
  shiftId: f.field(optionalText(80)),
  sourceShiftId: f.field(optionalText(80)),
  linkedPatientKey: f.field(optionalText(120)),
  linkedPatientDisplayName: f.field(optionalText(120)),
  linkedPatientLocation: f.field(optionalText(120)),
  participants: f.field(stringList),
  sharedWithUserIds: f.field(stringList),
  priorityPreference: f.field(s.defaulted(s.string(), 'balanced')),
  consentMode: f.field(s.literal('agreed')),
  notes: f.field(optionalText()),
  manualTranscript: f.field(optionalText(12_000)),
  recordingUploadId: f.field(recordingUploadId),
})
const extensionSchema = f.object({
  transcript: f.field(optionalText(12_000)),
  manualTranscript: f.field(optionalText(12_000)),
  recordingUploadId: f.field(recordingUploadId),
})
const checklistUpdateSchema = f.object({
  checklistItemId: f.field(requiredText(1, 120)),
  covered: f.field(booleanText),
})
const summaryUpdateSchema = f.object({
  section: f.field(s.union([
    s.literal('situation'),
    s.literal('background'),
    s.literal('assessment'),
    s.literal('recommendation'),
  ])),
  value: f.field(requiredText(1, 12_000)),
})
const summaryReviewSchema = f.object({ reviewed: f.field(booleanText) })
const metadataSchema = f.object({
  participants: f.field(optionalText(2_000)),
  patientKeys: f.field(stringList),
})
const privacyFindingRefsSchema = f.object({
  findingRefs: f.field(requiredText(2, 4_096).transform((value) => {
    try {
      let parsed: unknown = JSON.parse(value)
      if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 32) return []
      let refs: Array<{ auditId: string; ordinal: number }> = []
      for (let entry of parsed) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
        let ref = entry as Record<string, unknown>
        if (
          typeof ref.auditId !== 'string'
          || !ref.auditId.trim()
          || ref.auditId.length > 240
          || !Number.isSafeInteger(ref.ordinal)
          || Number(ref.ordinal) < 0
        ) return []
        refs.push({ auditId: ref.auditId.trim(), ordinal: Number(ref.ordinal) })
      }
      return refs
    } catch {
      return []
    }
  })),
})

type MetadataFormState = {
  participants: string
  patients: Array<{ patientKey: string; displayName: string; location: string }>
  errors: { form?: string; participants?: string; patients?: Array<{ displayName?: string; location?: string }> }
}

async function privacyJobSnapshot(
  db: Parameters<typeof getLocalFirstProcessingPreferenceForUser>[0],
  userId: string,
  handoverIds: readonly string[] = [],
) {
  let policy = resolveLocalFirstProcessingPolicy()
  let [userEnabled, localFirstHistory] = await Promise.all([
    getLocalFirstProcessingPreferenceForUser(db, userId),
    handoversHaveLocalFirstProcessingHistory(db, handoverIds),
  ])
  return {
    privacyMode: resolveEffectiveProcessingMode({ policy, userEnabled, localFirstHistory }),
    privacyPolicyVersion: currentPrivacyPolicyVersion,
  } as const
}

const taskPrioritySchema = s.enum_(handoverTaskPriorities)
const taskStatusSchema = s.enum_(handoverTaskStatuses)
const taskSourceSchema = s.enum_(handoverTaskSources)
const taskSchema = f.object({
  label: f.field(requiredText(1, 240)),
  patientKey: f.field(optionalText(120)),
  dueLabel: f.field(optionalText(120)),
  dueAt: f.field(optionalText(80)),
  dueLocal: f.field(optionalText(32)),
  priority: f.field(s.defaulted(taskPrioritySchema, 'routine')),
  status: f.field(s.defaulted(taskStatusSchema, 'open')),
  reminderEnabled: f.field(booleanText),
  source: f.field(s.defaulted(taskSourceSchema, 'manual')),
})
const taskDetailsUpdateSchema = f.object({
  label: f.field(requiredText(1, 240)),
  dueLabel: f.field(optionalText(120)),
  dueAt: f.field(optionalText(80)),
  dueLocal: f.field(optionalText(32)),
})
const taskReminderUpdateSchema = f.object({ reminderEnabled: f.field(booleanText) })
const taskStatusUpdateSchema = f.object({ status: f.field(taskStatusSchema) })
const assignmentSchema = f.object({
  handoverIds: f.field(stringList),
  assignedToUserId: f.field(requiredText(1, 80)),
})
const placeSchema = f.object({ shiftId: f.field(requiredText(1, 80)) })
const patientFieldSchema = f.object({
  fieldKey: f.field(s.defaulted(s.string(), '')),
  value: f.field(optionalText(4_000)),
  decision: f.field(s.defaulted(s.union([
    s.literal('accepted'),
    s.literal('edited'),
    s.literal('rejected'),
  ]), 'edited')),
})

function actorId(context: { get(key: typeof Auth): { ok: boolean; identity?: { id?: unknown } } }) {
  let auth = context.get(Auth)
  if (!auth.ok || typeof auth.identity?.id !== 'string') throw new Error('Authenticated user missing')
  return auth.identity.id
}

function target(context: { url: URL }, fallback: string) {
  return safeInternalPath(context.url.searchParams.get('returnTo')) ?? fallback
}

function handoverReviewHref(
  handover: { id: string; shift_id: string | null },
  reviewTab: ReviewTab = defaultReviewTab,
) {
  return routeReviewHref({ shiftId: handover.shift_id, handoverId: handover.id, reviewTab })
}

function invalid(message: string, status = 400) {
  return new Response(message, { status })
}

function uploadError(error: unknown, fallback: string) {
  if (error instanceof UploadValidationError || error instanceof HandoverSheetExtractionError) {
    return invalid(error.message, error.status)
  }
  console.error(error)
  return invalid(fallback, 500)
}

async function recordingUploadPlan(input: {
  kind: 'create' | 'extend'
  request: unknown
  audio: File
  userId: string
  recordingUploadId: string
}): Promise<{ requestFingerprint: string; storageKey: string }> {
  let contentSha256 = await sha256UploadFile(input.audio)
  let requestFingerprint = createHash('sha256').update(JSON.stringify({
    kind: input.kind,
    request: input.request,
    audio: {
      sha256: contentSha256,
      size: input.audio.size,
      contentType: input.audio.type.toLowerCase().split(';', 1)[0]!.trim(),
    },
  })).digest('hex')
  return {
    requestFingerprint,
    storageKey: digestBoundUploadKey({
      contentSha256,
      scope: JSON.stringify([input.userId, input.recordingUploadId, requestFingerprint]),
    }),
  }
}

function recordingMutationError(error: unknown, fallback: string) {
  return error instanceof HandoverRecordingUploadConflictError || error instanceof HandoverRecordingUploadGoneError
    ? invalid(error.message, error.status)
    : error instanceof ProvisionalAudioCleanupBusyError
      ? invalid(error.message, error.status)
      : error instanceof ResourceCleanupConflictError
        ? invalid('The recording upload could not be safely attached. Retry the upload.', 409)
    : uploadError(error, fallback)
}

function saved(context: { get(key: typeof Session): Session; request: Request }, _message: string, href: string) {
  return markFrameMutationSuccess(context.request, redirect(href, 303))
}

function metadataEditHref(context: { url: URL; params: { handoverId: string } }) {
  let href = target(context, routeReviewHref({ handoverId: context.params.handoverId, reviewTab: 'details' }))
  let url = new URL(href, 'http://remix.local')
  url.searchParams.set('edit', 'patient')
  url.hash = 'edit-patient-details'
  return `${url.pathname}${url.search}${url.hash}`
}

function invalidMetadata(context: any, state: MetadataFormState) {
  context.get(Session).flash(`metadataForm:${context.params.handoverId}`, state)
  return redirect(metadataEditHref(context), 303)
}

export default createController(routes.actions, {
  middleware: protectedFormMiddleware,
  actions: {
    async createShift(context) {
      let parsed = s.parseSafe(shiftSchema, context.get(FormData))
      if (!parsed.success) return invalid('Enter a shift name and department.')
      let shift = await createShift(context.get(DataRuntimeKey).db, {
        id: nanoid(),
        created_by_user_id: actorId(context),
        title: parsed.value.title,
        department: parsed.value.department,
        assigned_user_ids: parsed.value.assignedUserIds,
        notes: parsed.value.notes,
        patient_order: [],
        status: 'active',
      })
      return saved(context, 'Shift created.', routes.workspace.shift.href({ shiftId: shift.id }))
    },
    async deleteShift(context) {
      let db = context.get(DataRuntimeKey).db
      let sourceKeys = await collectShiftSheetSourceFileKeys(db, { shiftId: context.params.shiftId, userId: actorId(context) })
      if (!sourceKeys) return invalid('Shift not found.', 404)
      let deleted = await deleteShift(db, { id: context.params.shiftId, userId: actorId(context) })
      if (!deleted) return invalid('Shift not found.', 404)
      try {
        let orphanedKeys = await findUnreferencedShiftSheetSourceFileKeys(db, sourceKeys)
        await Promise.all(orphanedKeys.map((key) => context.get(UploadStores).sheets.delete(key)))
      } catch (error) {
        console.error('Shift deleted, but handover-sheet cleanup failed.', error)
      }
      return saved(context, 'Shift deleted.', routes.workspace.shiftSelection.href())
    },
    async updateShiftPatient(context) {
      let parsed = s.parseSafe(shiftPatientDetailsSchema, context.get(FormData))
      if (!parsed.success || !parsed.value.displayName.trim() || !parsed.value.location.trim()) {
        return invalid('Enter both a patient name and location.')
      }
      let updated = await updateShiftPatientDetails(context.get(DataRuntimeKey).db, {
        shiftId: context.params.shiftId,
        patientKey: context.params.patientKey,
        handoverId: parsed.value.handoverId || null,
        displayName: parsed.value.displayName,
        location: parsed.value.location,
        userId: actorId(context),
      })
      if (!updated) return invalid('Patient not found.', 404)
      return saved(context, 'Patient details saved.', target(context, routes.workspace.shift.href({ shiftId: context.params.shiftId })))
    },
    async orderPatients(context) {
      let parsed = s.parseSafe(orderSchema, context.get(FormData))
      if (!parsed.success) return invalid('Patient order is invalid.')
      let shift = await setShiftPatientOrder(context.get(DataRuntimeKey).db, { id: context.params.shiftId, userId: actorId(context), patientOrder: parsed.value.patientKeys })
      if (!shift) return invalid('Shift not found.', 404)
      return saved(context, 'Patient order saved.', routes.workspace.shift.href({ shiftId: shift.id }))
    },
    async prioritiseShift(context) {
      try {
        let runtime = context.get(DataRuntimeKey)
        let shift = await prioritiseShiftBoard(
          runtime.db,
          { shiftId: context.params.shiftId, userId: actorId(context) },
          {
            localFirstRequester: (denyTerms) => createDeidentifiedShiftPrioritisationRequester(
              createLocalPrivacyClient({
                storage: context.get(UploadStores).audio,
                env: process.env,
              }),
              createConfiguredShiftPrioritisationRequester(process.env),
              {
                audit: createLocalPrivacyAuditSink(runtime.db, {
                  shiftId: context.params.shiftId,
                  initiatedByUserId: actorId(context),
                }),
                model: process.env.OPENAI_MODEL?.trim() || 'gpt-5.5',
                denyTerms,
              },
            ),
          },
        )
        if (!shift) return invalid('Shift not found.', 404)
        return saved(context, 'Patient board prioritised.', routes.workspace.shift.href({ shiftId: shift.id }))
      } catch {
        console.error('Shift prioritisation failed.')
        return invalid('Priority order could not be calculated. Try again.', 502)
      }
    },
    async createHandover(context) {
      let form = context.get(FormData)
      let parsed = s.parseSafe(handoverSchema, form)
      if (!parsed.success) return invalid('Check the handover details and consent selection.')
      let rawAudio = fileUpload(form, context.get(TemporaryUploadFiles), 'audio')
      if (!parsed.value.manualTranscript && !rawAudio) return invalid('Provide a transcript or an audio recording.')
      if (parsed.value.manualTranscript && rawAudio) {
        return invalid('Provide either a transcript or an audio recording, not both.')
      }
      if (rawAudio && !parsed.value.recordingUploadId) return invalid('Recording upload identifier is required.')
      if (!rawAudio && parsed.value.recordingUploadId) return invalid('Recording upload identifier requires an audio recording.')
      let db = context.get(DataRuntimeKey).db
      let userId = actorId(context)
      let privacy = await privacyJobSnapshot(db, userId)
      if (
        rawAudio
        && privacy.privacyMode === 'local-first'
        && !isLocalFirstAudioStorageBackendCompatible()
      ) {
        return invalid('Local-first audio requires workstation-local filesystem storage.', 409)
      }
      let shiftBindings = [...new Set([parsed.value.shiftId, parsed.value.sourceShiftId].filter(Boolean))]
      if (shiftBindings.length) {
        let accessibleShifts = await Promise.all(shiftBindings.map((shiftId) => getShiftForUser(db, shiftId, userId)))
        if (accessibleShifts.some((shift) => !shift)) return invalid('Shift not found.', 404)
      }
      let recordingPlan: Awaited<ReturnType<typeof recordingUploadPlan>> | null = null
      try {
        if (rawAudio) recordingPlan = await recordingUploadPlan({
          kind: 'create',
          request: parsed.value,
          audio: rawAudio,
          userId,
          recordingUploadId: parsed.value.recordingUploadId,
        })
      } catch (error) {
        return uploadError(error, 'The recording upload could not be read.')
      }
      let recordingIntent = recordingPlan ? {
        recordingUploadId: parsed.value.recordingUploadId,
        userId,
        kind: 'create' as const,
        targetHandoverId: null,
        requestFingerprint: recordingPlan.requestFingerprint,
      } : null
      let sourceDepartment = parsed.value.sourceDepartment
      let destinationDepartment = parsed.value.destinationDepartment
      if (parsed.value.contextType === 'shift-handover') {
        if (parsed.value.direction === 'incoming' && destinationDepartment) {
          let receivingDepartment = sourceDepartment
          sourceDepartment = destinationDepartment
          destinationDepartment = receivingDepartment
        } else {
          destinationDepartment = ''
        }
      }
      let handoverId = nanoid()
      let jobId = nanoid()
      let storedAudio: StoredUpload | null = null
      let provisionalCleanupId: string | null = null
      try {
        if (recordingIntent) {
          let replay = await resolveHandoverRecordingUpload(db, recordingIntent)
          if (replay) return saved(context, 'Handover queued for processing.', handoverReviewHref(replay.handover, 'details'))
        }
        if (rawAudio && recordingIntent && recordingPlan) {
          let provisional = await enqueueProvisionalAudioUploadCleanup(db, {
            blobKey: recordingPlan.storageKey,
            userId,
            recordingUploadId: recordingIntent.recordingUploadId,
          })
          provisionalCleanupId = provisional.id
          storedAudio = await storeUploadAtKey(context.get(UploadStores).audio, recordingPlan.storageKey, rawAudio)
        }
        let result = await db.transaction(async (tx) => {
          if (recordingIntent) {
            await lockHandoverRecordingUpload(tx, recordingIntent)
            let replay = await resolveHandoverRecordingUpload(tx, recordingIntent)
            if (replay) {
              if (storedAudio && provisionalCleanupId) {
                await consumeProvisionalAudioUploadCleanupInTransaction(tx, {
                  cleanupId: provisionalCleanupId,
                  blobKey: storedAudio.key,
                  userId,
                  recordingUploadId: recordingIntent.recordingUploadId,
                  allowMissing: true,
                })
              }
              return { handover: replay.handover, replayed: true }
            }
          }
          if (storedAudio && recordingIntent && provisionalCleanupId) {
            await consumeProvisionalAudioUploadCleanupInTransaction(tx, {
              cleanupId: provisionalCleanupId,
              blobKey: storedAudio.key,
              userId,
              recordingUploadId: recordingIntent.recordingUploadId,
            })
          } else if (storedAudio) {
            await lockAudioBlobKeyForReferenceAssignment(tx, storedAudio.key)
          }
          let created = await createHandover(tx, {
        id: handoverId,
        created_by_user_id: userId,
        source_handover_id: null,
        shift_id: parsed.value.shiftId || null,
        source_shift_id: parsed.value.sourceShiftId || null,
        title: parsed.value.title,
        direction: parsed.value.direction === 'outgoing'
          ? 'outgoing'
          : parsed.value.direction === 'intra-shift'
            ? 'intra-shift'
            : 'incoming',
        source_department: sourceDepartment,
        destination_department: destinationDepartment,
        context_type: parsed.value.contextType,
        linked_patient_key: parsed.value.linkedPatientKey || null,
        linked_patient_display_name: parsed.value.linkedPatientDisplayName || null,
        linked_patient_location: parsed.value.linkedPatientLocation || null,
        participants: parsed.value.participants.map((name) => ({ name })),
        participants_edited: false,
        shared_with_user_ids: parsed.value.sharedWithUserIds,
        consent_mode: parsed.value.consentMode,
        priority_preference: parsed.value.priorityPreference,
        notes: parsed.value.notes,
        audio_blob_key: storedAudio?.key ?? null,
        audio_content_type: storedAudio?.contentType ?? null,
        audio_original_filename: storedAudio?.originalFilename ?? null,
        audio_size_bytes: storedAudio?.sizeBytes ?? null,
        transcript: parsed.value.manualTranscript,
        transcription_metadata: null,
        analysis: null,
        processing_status: 'queued',
        processing_started_at: new Date(),
        error_message: null,
        version: 1,
        current_job_id: jobId,
        processing_lease_until: null,
          })
          if (storedAudio) {
            await attachHandoverAudio(tx, {
              id: nanoid(), handoverId, userId, revision: 1, purpose: 'initial', key: storedAudio.key,
              contentType: storedAudio.contentType, originalFilename: storedAudio.originalFilename,
              sizeBytes: storedAudio.sizeBytes,
            })
          }
          await enqueueHandoverJob(tx, {
            id: jobId,
            handoverId,
            revision: 1,
            kind: 'create',
            payload: {
              manualTranscript: parsed.value.manualTranscript,
              audioBlobKey: storedAudio?.key ?? null,
              audioOriginalFilename: storedAudio?.originalFilename ?? null,
              ...privacy,
            },
          })
          if (recordingIntent) {
            await recordHandoverRecordingUpload(tx, {
              ...recordingIntent,
              handoverId,
              jobId,
            })
          }
          return { handover: created, replayed: false }
        })
        // A queued handover only supports the Details tab. Sending the browser
        // to Checklist here makes the workspace Frame immediately receive the
        // tab-normalisation 303, which Remix Frames correctly surface as an
        // error instead of silently following as a document navigation.
        return saved(context, 'Handover queued for processing.', handoverReviewHref(result.handover, 'details'))
      } catch (error) {
        return recordingMutationError(error, 'The handover could not be created.')
      }
    },
    async deleteHandover(context) {
      let db = context.get(DataRuntimeKey).db
      let userId = actorId(context)
      let handover = await getHandoverForUser(db, context.params.handoverId, userId)
      if (!handover) return invalid('Handover not found.', 404)
      let orphanedKeys = await deleteHandoverAndCollectOrphanedAudioKeys(db, { id: context.params.handoverId, userId })
      if (!orphanedKeys) return invalid('Handover not found.', 404)
      return saved(context, 'Handover deleted.', handover.shift_id
        ? routes.workspace.shift.href({ shiftId: handover.shift_id })
        : routes.workspace.individual.href())
    },
    async discardFailedHandover(context) {
      let db = context.get(DataRuntimeKey).db
      let userId = actorId(context)
      let handover = await getHandoverForUser(db, context.params.handoverId, userId)
      if (!handover) return invalid('Handover not found.', 404)
      if (handover.processing_status !== 'failed') return invalid('Only a failed processing attempt can be discarded.', 409)
      let result = await discardFailedHandoverAttempt(db, { id: handover.id, userId })
      if (!result) return invalid('The failed processing attempt is no longer available.', 409)
      if (result.outcome === 'unsafe') return invalid(result.reason, 409)
      if (result.outcome === 'deleted') {
        return saved(context, 'Failed handover discarded.', handover.shift_id
          ? routes.workspace.shift.href({ shiftId: handover.shift_id })
          : routes.workspace.individual.href())
      }
      return saved(context, 'Failed attempt discarded.', target(context, handoverReviewHref(handover, 'details')))
    },
    async extendHandover(context) {
      let form = context.get(FormData)
      let parsed = s.parseSafe(extensionSchema, form)
      let transcript = parsed.success ? parsed.value.manualTranscript || parsed.value.transcript : ''
      let rawAudio = fileUpload(form, context.get(TemporaryUploadFiles), 'audio')
      if (!parsed.success || (!transcript && !rawAudio)) return invalid('Provide an extension transcript or audio.')
      if (transcript && rawAudio) return invalid('Provide either an extension transcript or audio, not both.')
      if (rawAudio && !parsed.value.recordingUploadId) return invalid('Recording upload identifier is required.')
      if (!rawAudio && parsed.value.recordingUploadId) return invalid('Recording upload identifier requires an audio recording.')
      let db = context.get(DataRuntimeKey).db
      let userId = actorId(context)
      let handover = await getHandoverForUser(db, context.params.handoverId, userId)
      if (!handover) return invalid('Handover not found.', 404)
      let privacy = await privacyJobSnapshot(db, userId, [
        handover.id,
        handover.source_handover_id ?? '',
      ])
      if (
        rawAudio
        && privacy.privacyMode === 'local-first'
        && !isLocalFirstAudioStorageBackendCompatible()
      ) {
        return invalid('Local-first audio requires workstation-local filesystem storage.', 409)
      }
      let extensionRequest = {
        handoverId: context.params.handoverId,
        transcript: parsed.value.transcript,
        manualTranscript: parsed.value.manualTranscript,
        recordingUploadId: parsed.value.recordingUploadId,
      }
      let recordingPlan: Awaited<ReturnType<typeof recordingUploadPlan>> | null = null
      try {
        if (rawAudio) recordingPlan = await recordingUploadPlan({
          kind: 'extend',
          request: extensionRequest,
          audio: rawAudio,
          userId,
          recordingUploadId: parsed.value.recordingUploadId,
        })
      } catch (error) {
        return uploadError(error, 'The recording upload could not be read.')
      }
      let recordingIntent = recordingPlan ? {
        recordingUploadId: parsed.value.recordingUploadId,
        userId,
        kind: 'extend' as const,
        targetHandoverId: context.params.handoverId,
        requestFingerprint: recordingPlan.requestFingerprint,
      } : null
      let storedAudio: StoredUpload | null = null
      let provisionalCleanupId: string | null = null
      let extensionJobId = nanoid()
      try {
        if (recordingIntent) {
          let replay = await resolveHandoverRecordingUpload(db, recordingIntent)
          if (replay) return saved(context, 'Extension queued.', handoverReviewHref(replay.handover, 'details'))
        }
        if (rawAudio && recordingIntent && recordingPlan) {
          let provisional = await enqueueProvisionalAudioUploadCleanup(db, {
            blobKey: recordingPlan.storageKey,
            userId,
            recordingUploadId: recordingIntent.recordingUploadId,
          })
          provisionalCleanupId = provisional.id
          storedAudio = await storeUploadAtKey(context.get(UploadStores).audio, recordingPlan.storageKey, rawAudio)
        }
        let result = await extendHandover(db, {
          id: context.params.handoverId, userId, jobId: extensionJobId,
          payload: {
            manualTranscript: transcript,
            audioBlobKey: storedAudio?.key ?? null,
            audioOriginalFilename: storedAudio?.originalFilename ?? null,
            ...privacy,
          },
          audio: storedAudio ? {
            id: nanoid(), key: storedAudio.key, contentType: storedAudio.contentType,
            originalFilename: storedAudio.originalFilename, sizeBytes: storedAudio.sizeBytes,
            provisionalCleanupId: provisionalCleanupId ?? undefined,
          } : undefined,
          recordingUpload: recordingIntent ? { id: recordingIntent.recordingUploadId, requestFingerprint: recordingIntent.requestFingerprint } : undefined,
        })
        if (!result) return invalid('Handover not found.', 404)
        return saved(context, 'Extension queued.', handoverReviewHref(result.handover, 'details'))
      } catch (error) {
        return recordingMutationError(error, 'The handover extension could not be queued.')
      }
    },
    async retryHandover(context) {
      let db = context.get(DataRuntimeKey).db
      let userId = actorId(context)
      let handover = await getHandoverForUser(db, context.params.handoverId, userId)
      if (!handover) return invalid('Handover not found.', 404)
      if (handover.processing_status !== 'failed') return invalid('Only failed handovers can be retried.', 409)
      let privacy = await privacyJobSnapshot(db, userId, [
        handover.id,
        handover.source_handover_id ?? '',
      ])
      try {
        if (!(await retryFailedHandoverJob(db, {
          id: nanoid(),
          handoverId: handover.id,
          privacy,
          localFirstAudioStorageCompatible: isLocalFirstAudioStorageBackendCompatible(),
        }))) {
          return invalid('Handover could not be retried.', 409)
        }
      } catch (error) {
        if (error instanceof Error && (
          error.message === 'Could not safely retry the recommenced handover transcript.'
          || error.message === 'Could not safely prepare source recording deletion for local-first retry.'
          || error.message === 'Local-first audio requires workstation-local filesystem storage.'
        )) {
          return invalid(error.message, 409)
        }
        throw error
      }
      return saved(context, 'Processing restarted.', target(context, handoverReviewHref(handover, 'details')))
    },
    async allowPrivacyFindings(context) {
      let parsed = s.parseSafe(privacyFindingRefsSchema, context.get(FormData))
      if (!parsed.success || parsed.value.findingRefs.length < 1) {
        return invalid('Select personal information to allow in analysis.')
      }
      let db = context.get(DataRuntimeKey).db
      let userId = actorId(context)
      let handover = await getHandoverForUser(db, context.params.handoverId, userId)
      if (!handover) return invalid('Handover not found.', 404)
      let result = await allowHandoverPrivacyFindingsForUser(db, {
        handoverId: handover.id,
        userId,
        findingRefs: parsed.value.findingRefs,
      })
      if (result.outcome === 'not-found') return invalid('Handover not found.', 404)
      if (result.outcome === 'unsupported') {
        return invalid('This personal information cannot be safely allowed with the current OpenMed findings.', 409)
      }
      if (result.outcome === 'stale') {
        return invalid('The transcript findings changed. Reload the transcript and try again.', 409)
      }
      return saved(
        context,
        'Personal information allowed in future analysis.',
        target(context, handoverReviewHref(handover, 'transcript')),
      )
    },
    async reanalyzeHandover(context) {
      let db = context.get(DataRuntimeKey).db
      let userId = actorId(context)
      let handover = await getHandoverForUser(db, context.params.handoverId, userId)
      if (!handover) return invalid('Handover not found.', 404)
      let outcome = await queueHandoverPrivacyReanalysisForUser(db, {
        handoverId: handover.id,
        userId,
        jobId: nanoid(),
      })
      if (outcome === 'not-found') return invalid('Handover not found.', 404)
      if (outcome === 'not-required') return invalid('This analysis already includes the allowed information.', 409)
      if (outcome === 'busy') return invalid('This handover is already being processed.', 409)
      if (outcome === 'cleanup-unproven') {
        return invalid('Source recording deletion could not be confirmed for this transcript.', 409)
      }
      return saved(
        context,
        'Analysis queued.',
        target(context, handoverReviewHref(handover, 'details')),
      )
    },
    async updateMetadata(context) {
      let form = context.get(FormData)
      let parsed = s.parseSafe(metadataSchema, form)
      let rawParticipants = typeof form.get('participants') === 'string' ? String(form.get('participants')) : ''
      let patientKeys = parsed.success ? parsed.value.patientKeys : []
      let draftPatients = patientKeys.slice(0, 50).map((patientKey, index) => ({
        patientKey,
        displayName: typeof form.get(`patientDisplayName-${index}`) === 'string' ? String(form.get(`patientDisplayName-${index}`)) : '',
        location: typeof form.get(`patientLocation-${index}`) === 'string' ? String(form.get(`patientLocation-${index}`)) : '',
      }))
      if (!parsed.success || parsed.value.patientKeys.length > 50 || new Set(parsed.value.patientKeys).size !== parsed.value.patientKeys.length) {
        return invalidMetadata(context, {
          participants: rawParticipants,
          patients: draftPatients,
          errors: { form: 'Patient details are invalid.' },
        })
      }
      let patientErrors = draftPatients.map((patient) => ({
        ...(!patient.displayName.trim() || patient.displayName.trim().length > 120 ? { displayName: 'Enter a patient name of 120 characters or fewer.' } : {}),
        ...(!patient.location.trim() || patient.location.trim().length > 120 ? { location: 'Enter a location of 120 characters or fewer.' } : {}),
      }))
      if (patientKeys.some((patientKey) => patientKey.length > 80) || patientErrors.some((errors) => errors.displayName || errors.location)) {
        return invalidMetadata(context, {
          participants: rawParticipants,
          patients: draftPatients,
          errors: { form: 'Enter a valid name and location for each patient.', patients: patientErrors },
        })
      }
      let participants = [...new Set(parsed.value.participants
        .split(/[\n,]/)
        .map((participant) => participant.trim())
        .filter(Boolean))]
      if (participants.length > 50 || participants.some((participant) => participant.length > 80)) {
        return invalidMetadata(context, {
          participants: rawParticipants,
          patients: draftPatients,
          errors: { participants: 'Enter no more than 50 participants, using 80 characters or fewer for each name.' },
        })
      }
      let updated = await updateHandoverReviewMetadata(context.get(DataRuntimeKey).db, {
        id: context.params.handoverId,
        userId: actorId(context),
        participants,
        patients: draftPatients.map((patient) => ({ ...patient, displayName: patient.displayName.trim(), location: patient.location.trim() })),
      })
      if (!updated) return invalid('Handover not found.', 404)
      return saved(context, 'Patient details saved.', target(context, routeReviewHref({ handoverId: updated.id, reviewTab: 'details' })))
    },
    async updateChecklist(context) {
      let parsed = s.parseSafe(checklistUpdateSchema, context.get(FormData))
      if (!parsed.success) return invalid('Checklist review is invalid.')
      let updated = await updateHandoverChecklistItem(context.get(DataRuntimeKey).db, {
        id: context.params.handoverId,
        userId: actorId(context),
        checklistItemId: parsed.value.checklistItemId,
        covered: parsed.value.covered,
      })
      if (!updated) return invalid('Checklist item not found.', 404)
      let handover = await getHandoverForUser(context.get(DataRuntimeKey).db, context.params.handoverId, actorId(context))
      if (!handover) return invalid('Handover not found.', 404)
      return saved(context, 'Checklist saved.', target(context, handoverReviewHref(handover)))
    },
    async updateSummary(context) {
      let parsed = s.parseSafe(summaryUpdateSchema, context.get(FormData))
      if (!parsed.success) return invalid('Structured summary is invalid.')
      let updated = await updateHandoverSummarySection(context.get(DataRuntimeKey).db, {
        id: context.params.handoverId,
        userId: actorId(context),
        section: parsed.value.section as 'situation' | 'background' | 'assessment' | 'recommendation',
        value: parsed.value.value,
      })
      if (!updated) return invalid('Summary section not found.', 404)
      let handover = await getHandoverForUser(context.get(DataRuntimeKey).db, context.params.handoverId, actorId(context))
      if (!handover) return invalid('Handover not found.', 404)
      return saved(context, 'Summary saved.', target(context, handoverReviewHref(handover, 'summary')))
    },
    async updateSummaryReview(context) {
      let parsed = s.parseSafe(summaryReviewSchema, context.get(FormData))
      if (!parsed.success) return invalid('Summary review status is invalid.')
      let updated = await updateHandoverSummaryReviewStatus(context.get(DataRuntimeKey).db, {
        id: context.params.handoverId,
        userId: actorId(context),
        reviewed: parsed.value.reviewed,
      })
      if (!updated) return invalid('Summary review state not found.', 404)
      let handover = await getHandoverForUser(context.get(DataRuntimeKey).db, context.params.handoverId, actorId(context))
      if (!handover) return invalid('Handover not found.', 404)
      return saved(context, parsed.value.reviewed ? 'Summary marked as reviewed.' : 'Summary marked as needing review.', target(context, handoverReviewHref(handover, 'summary')))
    },
    async createTask(context) {
      return saveTask(context, context.params.handoverId, null)
    },
    async createUncertaintyTask(context) {
      return saveTask(context, context.params.handoverId, context.params.uncertaintyId)
    },
    async updateTask(context) {
      let form = context.get(FormData)
      let intent = form.get('_intent')
      if (intent === 'details') {
        let parsed = s.parseSafe(taskDetailsUpdateSchema, form)
        if (!parsed.success) return invalid('Task details are invalid.')
        let hasDueFields = form.has('dueAt') || form.has('dueLocal')
        let due = hasDueFields ? resolveTaskDueInput(parsed.value) : null
        if (due && !due.success) return invalid('Choose a valid due date and time.')
        return saveTaskFields(context, {
          title: parsed.value.label,
          dueLabel: due?.success ? due.dueLabel : parsed.value.dueLabel || 'No due date set',
          ...(due?.success ? { dueAt: due.dueAt } : {}),
        })
      }
      if (intent === 'reminder') {
        let parsed = s.parseSafe(taskReminderUpdateSchema, form)
        if (!parsed.success) return invalid('Task reminder is invalid.')
        return saveTaskFields(context, { reminderEnabled: parsed.value.reminderEnabled })
      }
      if (intent != null) return invalid('Task update is invalid.')
      let statusValue = form.get('status')
      if (typeof statusValue === 'string' && form.get('title') == null) {
        let parsed = s.parseSafe(taskStatusUpdateSchema, form)
        if (!parsed.success) return invalid('Task status is invalid.')
        let updated = await setTaskStatus(context.get(DataRuntimeKey).db, { id: context.params.taskId, userId: actorId(context), status: parsed.value.status })
        if (!updated) return invalid('Task not found.', 404)
        return saved(context, 'Task saved.', target(context, routes.workspace.individual.href()))
      }
      // Retain safe compatibility for any older full-edit form while ignoring
      // client-supplied handover, patient, priority, source, and linkage fields.
      let parsed = s.parseSafe(taskSchema, form)
      if (!parsed.success) return invalid('Task details are invalid.')
      let hasDueFields = form.has('dueAt') || form.has('dueLocal')
      let due = hasDueFields ? resolveTaskDueInput(parsed.value) : null
      if (due && !due.success) return invalid('Choose a valid due date and time.')
      return saveTaskFields(context, {
        title: parsed.value.label,
        dueLabel: due?.success ? due.dueLabel : parsed.value.dueLabel || 'No due date set',
        ...(due?.success ? { dueAt: due.dueAt } : {}),
        status: parsed.value.status,
        reminderEnabled: parsed.value.reminderEnabled,
      })
    },
    async deleteTask(context) {
      if (!(await deleteHandoverTask(context.get(DataRuntimeKey).db, { id: context.params.taskId, userId: actorId(context) }))) return invalid('Task not found.', 404)
      return saved(context, 'Task deleted.', target(context, routes.workspace.individual.href()))
    },
    async createAssignments(context) {
      let parsed = s.parseSafe(assignmentSchema, context.get(FormData))
      if (!parsed.success || !parsed.value.handoverIds.length) return invalid('Choose at least one handover and recipient.')
      let created = 0
      for (let handoverId of parsed.value.handoverIds) {
        if (await createAssignment(context.get(DataRuntimeKey).db, { id: nanoid(), handoverId, assignedByUserId: actorId(context), assignedToUserId: parsed.value.assignedToUserId })) created++
      }
      if (!created) return invalid('No eligible handovers were found.', 404)
      return saved(context, `${created} handover${created === 1 ? '' : 's'} sent.`, target(context, routes.workspace.individual.href()))
    },
    async placeAssignment(context) {
      let parsed = s.parseSafe(placeSchema, context.get(FormData))
      if (!parsed.success) return invalid('Choose a shift.')
      let assignment = await placeAssignment(context.get(DataRuntimeKey).db, { id: context.params.assignmentId, userId: actorId(context), targetShiftId: parsed.value.shiftId })
      if (!assignment) return invalid('Inbox item not found.', 404)
      return saved(context, 'Handover added to shift.', routes.workspace.shift.href({ shiftId: parsed.value.shiftId }))
    },
    async addAssignmentToIndividual(context) {
      let assignment = await addAssignmentToIndividual(context.get(DataRuntimeKey).db, { id: context.params.assignmentId, userId: actorId(context) })
      if (!assignment) return invalid('Inbox item not found.', 404)
      return saved(context, 'Handover added to individual workspace.', routes.workspace.individual.href())
    },
    async dismissAssignment(context) {
      let dismissed = await dismissAssignment(context.get(DataRuntimeKey).db, { id: context.params.assignmentId, userId: actorId(context) })
      if (!dismissed) return invalid('Inbox item not found.', 404)
      return saved(context, 'Inbox item removed.', routes.workspace.inbox.href())
    },
    async importHandoverSheet(context) {
      let upload = fileUpload(context.get(FormData), context.get(TemporaryUploadFiles), 'sheet')
      if (!upload) return invalid('Choose a handover sheet to import.')
      let db = context.get(DataRuntimeKey).db
      let userId = actorId(context)
      let replacedSourceKeys = await collectShiftSheetSourceFileKeys(db, { shiftId: context.params.shiftId, userId })
      if (!replacedSourceKeys) return invalid('Shift not found.', 404)
      let extraction: Awaited<ReturnType<typeof extractHandoverSheet>>
      let result: Awaited<ReturnType<typeof importShiftHandoverSheet>>
      try {
        // The Remix upload middleware already stages the request-owned file.
        // Extract directly from that temporary File and persist only the
        // structured result; never copy the original into durable storage.
        extraction = await extractHandoverSheet(upload)
        result = await importShiftHandoverSheet(db, {
          shiftId: context.params.shiftId,
          userId,
          extraction,
        })
        if (!result) return invalid('Shift not found.', 404)
      } catch (error) {
        return uploadError(error, 'The handover sheet could not be imported.')
      }
      try {
        let orphanedKeys = await findUnreferencedShiftSheetSourceFileKeys(db, replacedSourceKeys)
        await Promise.all(orphanedKeys.map((key) => context.get(UploadStores).sheets.delete(key)))
      } catch (error) {
        console.error('Handover sheet imported, but replaced source cleanup failed.', error)
      }
      return saved(
        context,
        `${result.imported} patient${result.imported === 1 ? '' : 's'} imported.`,
        routes.workspace.shift.href({ shiftId: context.params.shiftId }),
      )
    },
    async reviewPatientDetails(context) {
      let parsed = s.parseSafe(patientFieldSchema, context.get(FormData))
      if (!parsed.success || !parsed.value.fieldKey) return invalid('Choose a patient field to review.')
      return reviewPatientField(
        context,
        parsed.value.fieldKey,
        parsed.value.value,
        parsed.value.decision as 'accepted' | 'edited' | 'rejected',
      )
    },
    async reviewPatientField(context) {
      let parsed = s.parseSafe(patientFieldSchema, context.get(FormData))
      if (!parsed.success) return invalid('Reviewed value must be text.')
      return reviewPatientField(
        context,
        context.params.fieldKey,
        parsed.value.value,
        parsed.value.decision as 'accepted' | 'edited' | 'rejected',
      )
    },
  },
})

async function saveTask(context: any, handoverId: string, uncertaintyId: string | null) {
  let parsed = s.parseSafe(taskSchema, context.get(FormData))
  if (!parsed.success) return invalid('Task details are invalid.')
  let due = resolveTaskDueInput(parsed.value)
  if (!due.success) return invalid('Choose a valid due date and time.')
  let now = new Date()
  let task = await createHandoverTask(context.get(DataRuntimeKey).db, {
    id: nanoid(),
    handover_id: handoverId,
    patient_key: parsed.value.patientKey,
    title: parsed.value.label,
    due_label: due.dueLabel,
    due_at: due.dueAt,
    // Creation policy is server-owned. Hidden inputs document the UI state,
    // but must not let a tampered request create an already-completed or
    // artificially urgent task.
    priority: 'routine',
    status: 'open',
    reminder_enabled: parsed.value.reminderEnabled,
    carried_forward: false,
    // Analysis-owned sources are replaced during later analysis runs, so a
    // manual task must never be able to masquerade as one of them.
    source: uncertaintyId ? 'uncertainty' : 'manual',
    related_uncertainty_id: uncertaintyId,
    created_at: now,
    updated_at: now,
    userId: actorId(context),
  })
  if (!task) return invalid('Patient or handover not found.', 404)
  return saved(context, 'Task saved.', target(context, routeReviewHref({ handoverId, reviewTab: 'tasks' })))
}

async function saveTaskFields(context: any, patch: {
  title?: string
  dueLabel?: string
  dueAt?: Date | null
  status?: HandoverTaskStatus
  reminderEnabled?: boolean
}) {
  let task = await updateTaskFields(context.get(DataRuntimeKey).db, {
    id: context.params.taskId,
    userId: actorId(context),
    ...patch,
  })
  if (!task) return invalid('Task not found.', 404)
  return saved(context, 'Task saved.', target(context, routeReviewHref({ handoverId: task.handover_id, reviewTab: 'tasks' })))
}

async function reviewPatientField(
  context: any,
  fieldKey: string,
  value: string,
  decision: 'accepted' | 'edited' | 'rejected',
) {
  try {
    let updated = await reviewShiftSheetPatientField(context.get(DataRuntimeKey).db, {
      shiftId: context.params.shiftId,
      patientKey: context.params.patientKey,
      columnKey: fieldKey,
      value,
      decision,
      userId: actorId(context),
    })
    if (!updated) return invalid('Patient not found in this shift.', 404)
    return saved(context, 'Patient field reviewed.', routes.workspace.patient.href({ shiftId: context.params.shiftId, patientKey: context.params.patientKey }))
  } catch (error) {
    if (error instanceof Error && error.message === 'Unknown handover sheet field.') return invalid(error.message)
    console.error(error)
    return invalid('The patient field could not be reviewed.', 500)
  }
}
