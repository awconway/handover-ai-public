import { Auth } from 'remix/middleware/auth'
import { getCsrfToken } from 'remix/middleware/csrf'
import { createController } from 'remix/router'
import { redirect } from 'remix/response/redirect'
import { Session } from 'remix/session'
import type { RemixNode } from 'remix/component'

import { documentAssetHrefs } from '../../assets.ts'
import {
  buildPatientWorksheetFields,
  patientWorksheetFieldsFromAnalysis,
  analysisPatientCount,
  buildShiftWorkspaceReadModel,
  getHandoverForUser,
  getHandoverTranscriptPrivacyAuditForUser,
  getLocalFirstProcessingPreferenceForUser,
  handoversHaveLocalFirstProcessingHistory,
  getShiftForUser,
  listAccessibleShiftHandoverPatientsForUser,
  listAccessibleShiftSheetPatientsForUser,
  listHandoversForUser,
  listPendingAssignmentsForUser,
  listShiftsForUser,
  listShiftHandoverPatientsForUser,
  listShiftSheetPatientsForUser,
  listTasksForUser,
  listUsers,
  resolveEffectiveProcessingMode,
  resolveLocalFirstProcessingPolicy,
  handoverSubtitle,
  isHandoverRelatedToShift,
  resolveWorkspacePatientReadModel,
  resolveShiftScopedHandoverDirection,
  type ShiftWorkspaceReadModel,
  type WorkspaceHandoverReadModel,
} from '../../data/index.ts'
import { isPlaceholderPatientKey, patientIdentityKey } from '../../data/patient-identity.ts'
import { requireUser } from '../../middleware/auth.ts'
import { DataRuntimeKey } from '../../middleware/data.ts'
import { publicFormMiddleware } from '../../middleware/forms.ts'
import { normalizeReviewAnalysis, normalizeTranscriptionMetadata, participantNames } from '../../utils/handover-review.ts'
import {
  defaultReviewTab,
  normalizePatientWorkspaceTab,
  normalizeReviewTab,
  patientWorkspaceActionHref,
  patientWorkspaceHref,
  patientWorkspaceTabs,
  reviewHref,
  reviewTabs,
  routes,
  type ReviewTab,
} from '../../routes.ts'
import {
  AppShell,
  Document,
  HandoverReviewPage,
  InboxPage,
  IndividualPage,
  ModeHomePage,
  NotFoundPage,
  PatientWorkspacePage,
  ShiftBoardPage,
  ShiftSelectionPage,
  WorkspaceSurface,
  type HandoverSummary,
  type PatientSummary,
  type SessionSummary,
  type ShiftSummary,
  type TaskSummary,
  type WorkspaceBreadcrumb,
} from '../../ui/index.ts'

function user(context: any): SessionSummary {
  let auth = context.get(Auth)
  if (!auth.ok) throw new Error('Authenticated user missing')
  return {
    user: {
      id: auth.identity.id,
      fullName: auth.identity.name,
      occupation: auth.identity.role ?? '',
      department: auth.identity.department ?? '',
    },
  }
}

function handoverSummary(row: any, shiftId?: string | null): HandoverSummary {
  let reviewTab: ReviewTab = row.processing_status !== 'completed' && row.processing_status !== 'failed'
    ? 'details'
    : defaultReviewTab
  return {
    id: row.id,
    shiftId: shiftId ?? undefined,
    title: row.title,
    subtitle: handoverSubtitle(row),
    status: row.processing_status,
    direction: shiftId ? resolveShiftScopedHandoverDirection(row, shiftId) : row.direction ?? undefined,
    patientCount: analysisPatientCount(row.analysis),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    href: reviewHref({ shiftId, handoverId: row.id, reviewTab }),
  }
}

function canonicalPatientWorkspaceKey(
  patient: { patientKey: string; displayName?: string | null; location?: string | null },
  sheetPatients: Array<{ patient_key: string; display_name: string; location: string }>,
) {
  if (!isPlaceholderPatientKey(patient.patientKey)) return patient.patientKey
  let identityKey = patientIdentityKey({
    key: patient.patientKey,
    displayName: patient.displayName,
    location: patient.location,
  })
  if (!identityKey) return undefined
  let sheetMatches = sheetPatients.filter((sheetPatient) =>
    patientIdentityKey({
      key: sheetPatient.patient_key,
      displayName: sheetPatient.display_name,
      location: sheetPatient.location,
    }) === identityKey,
  )
  if (sheetMatches.length > 1) return undefined
  return sheetMatches[0]?.patient_key ?? identityKey
}

async function redirectToDefaultHandoverTab(context: any, shiftId: string | null) {
  let handover = await getHandoverForUser(
    context.get(DataRuntimeKey).db,
    context.params.handoverId,
    user(context).user.id,
  )
  if (!handover || (shiftId && !isHandoverRelatedToShift(handover, shiftId))) return notFound(context)
  let tab: ReviewTab = handover.processing_status !== 'completed' && handover.processing_status !== 'failed'
    ? 'details'
    : defaultReviewTab
  return redirect(reviewHref({ shiftId, handoverId: handover.id, reviewTab: tab }), 303)
}

function handoverViewerPerspective(options: {
  handover: any
  shiftId: string | null
  userId: string
  inboxAssignment?: any
}): 'receiving' | 'delivering' {
  let { handover, shiftId, userId, inboxAssignment } = options
  let direction = handover.direction === 'outgoing'
    ? 'outgoing'
    : handover.direction === 'intra-shift'
      ? 'intra-shift'
      : 'incoming'

  if (inboxAssignment?.status === 'pending' || handover.source_handover_id) return 'receiving'

  if (shiftId) {
    if (handover.source_shift_id && handover.source_shift_id !== handover.shift_id) {
      if (shiftId === handover.source_shift_id) return 'delivering'
      if (shiftId === handover.shift_id) return 'receiving'
    }

    if (handover.shift_id === shiftId) {
      return direction === 'outgoing' && handover.created_by_user_id === userId
        ? 'delivering'
        : 'receiving'
    }
  }

  return handover.created_by_user_id === userId && direction === 'outgoing'
    ? 'delivering'
    : 'receiving'
}

function shiftSummary(
  row: any,
  handovers: any[] = [],
  sheetPatients: any[] = [],
  handoverPatients: any[] = [],
  tasks: any[] = [],
): ShiftSummary {
  let model = buildShiftWorkspaceReadModel({ shift: row, handovers, sheetPatients, handoverPatients, tasks })
  return shiftSummaryFromReadModel(model)
}

function handoverSummaryFromReadModel(model: WorkspaceHandoverReadModel, shiftId: string): HandoverSummary {
  return {
    ...handoverSummary(model.row, shiftId),
    direction: model.direction,
    subtitle: model.subtitle,
    patientCount: model.patientCount,
  }
}

function shiftSummaryFromReadModel(model: ShiftWorkspaceReadModel): ShiftSummary {
  let row = model.shift
  let patients: PatientSummary[] = model.patients.map((patientModel) => {
    let { sheetPatient, clinicalRows } = patientModel
    let linkedHandovers = [...patientModel.handovers, ...patientModel.processingHandovers]
    let latestClinicalRow = clinicalRows[0]
    let editableHandover = patientModel.handovers.find((handover) => handover.direction === 'incoming') ?? patientModel.handovers[0]
    return {
      key: patientModel.key,
      displayName: sheetPatient?.display_name ?? latestClinicalRow?.display_name ?? linkedHandovers.find((handover) => handover.row.linked_patient_display_name)?.row.linked_patient_display_name ?? patientModel.key,
      bed: sheetPatient?.location ?? latestClinicalRow?.location ?? linkedHandovers.find((handover) => handover.row.linked_patient_location)?.row.linked_patient_location ?? undefined,
      priority: patientModel.priorityScore >= 12 ? 'high' : patientModel.priorityScore >= 7 ? 'medium' : 'routine',
      handoverCount: patientModel.handovers.length,
      openTaskCount: patientModel.openTaskCount,
      hasSheet: Boolean(sheetPatient),
      editAction: sheetPatient || editableHandover
        ? routes.actions.updateShiftPatient.href({ shiftId: row.id, patientKey: patientModel.key })
        : undefined,
      editableHandoverId: editableHandover?.row.id,
      href: routes.workspace.patient.href({ shiftId: row.id, patientKey: patientModel.key }),
      handovers: patientModel.handovers.map((handover) => handoverSummaryFromReadModel(handover, row.id)),
      processingHandovers: patientModel.processingHandovers.map((handover) => handoverSummaryFromReadModel(handover, row.id)),
    }
  })
  let shiftSheetPatients = model.patients.flatMap((patient) => patient.sheetPatient ? [patient.sheetPatient] : [])
  let sheet = shiftSheetPatients[0]
  return {
    id: row.id,
    title: row.title,
    department: row.department,
    notes: row.notes,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    patientCount: model.patientCount,
    handoverCount: model.handoverCount,
    href: routes.workspace.shift.href({ shiftId: row.id }),
    patients,
    handovers: model.handovers.map((handover) => handoverSummaryFromReadModel(handover, row.id)),
    sheet: sheet ? {
      fileName: sheet.source_file_name,
      importedAt: sheet.imported_at instanceof Date ? sheet.imported_at.toISOString() : String(sheet.imported_at),
      patientCount: shiftSheetPatients.length,
    } : undefined,
  }
}

async function shellData(context: any) {
  let db = context.get(DataRuntimeKey).db
  let userId = user(context).user.id
  let [shiftRows, handoverRows, assignmentRows, users, tasks] = await Promise.all([
    listShiftsForUser(db, userId),
    listHandoversForUser(db, userId),
    listPendingAssignmentsForUser(db, userId),
    listUsers(db),
    listTasksForUser(db, userId),
  ])
  let [sheetPatients, handoverPatients] = await Promise.all([
    listAccessibleShiftSheetPatientsForUser(db, userId),
    listAccessibleShiftHandoverPatientsForUser(db, userId),
  ])
  return {
    shifts: shiftRows.map((shift) => shiftSummary(shift, handoverRows, sheetPatients, handoverPatients, tasks)),
    handovers: handoverRows.map((handover) => handoverSummary(handover, handover.shift_id)),
    inbox: assignmentRows.map((assignment) => {
      let handover = handoverRows.find((candidate) => candidate.id === assignment.handover_id)
      let sourceShift = shiftRows.find((candidate) => candidate.id === (handover?.source_shift_id ?? handover?.shift_id))
      let sourceDepartment = handover?.source_department ?? ''
      let destinationDepartment = handover?.destination_department ?? ''
      return {
        id: assignment.handover_id,
        assignmentId: assignment.id,
        title: handover?.title ?? 'Incoming handover',
        subtitle: handover ? handoverSubtitle(handover) : 'Ready for review',
        href: handover ? handoverSummary(handover, handover.shift_id).href : routes.workspace.inbox.href(),
        assignedBy: users.find((candidate) => candidate.id === assignment.assigned_by_user_id)?.full_name,
        assignedAt: assignment.assigned_at instanceof Date ? assignment.assigned_at.toISOString() : String(assignment.assigned_at),
        direction: handover?.direction ?? undefined,
        routeLabel: destinationDepartment ? `${sourceDepartment} -> ${destinationDepartment}` : sourceDepartment,
        sourceShiftTitle: sourceShift?.title,
        sourceShiftDepartment: sourceShift?.department,
        placeAction: routes.actions.placeAssignment.href({ assignmentId: assignment.id }),
        addToIndividualAction: routes.actions.addAssignmentToIndividual.href({ assignmentId: assignment.id }),
        dismissAction: routes.actions.dismissAssignment.href({ assignmentId: assignment.id }),
      }
    }),
  }
}

function workspaceBreadcrumbs(...items: WorkspaceBreadcrumb[]): WorkspaceBreadcrumb[] {
  return [
    {
      label: 'Workflows',
      href: routes.workspace.home.href(),
      back: true,
      ariaLabel: 'Back to workflow home',
      title: 'Workspace home',
    },
    ...items,
  ]
}

async function renderWorkspace(
  context: any,
  content: RemixNode,
  options: {
    mode: 'shift' | 'individual'
    currentHandoverId?: string
    title: string
    breadcrumbs: WorkspaceBreadcrumb[]
  },
) {
  let documentTitle = `${options.title} · Handover AI`
  let surface = <WorkspaceSurface breadcrumbs={options.breadcrumbs} documentTitle={documentTitle}>{content}</WorkspaceSurface>
  if (context.request.headers.get('X-Remix-Target') === 'workspace') {
    return context.render(surface)
  }
  let navigation = await shellData(context)
  let csrfToken = getCsrfToken(context)
  let auth = context.get(Auth)
  if (!auth.ok) throw new Error('Authenticated user missing')
  let privacyPolicy = resolveLocalFirstProcessingPolicy()
  let privacyMode = resolveEffectiveProcessingMode({
    policy: privacyPolicy,
    // Read the current persisted preference so the shell changes immediately
    // after a settings update; the authenticated identity is session-cached.
    userEnabled: await getLocalFirstProcessingPreferenceForUser(
      context.get(DataRuntimeKey).db,
      auth.identity.id,
    ),
  })
  // Consume legacy success flashes without presenting routine confirmations.
  context.get(Session).get('notice')
  let error = context.get(Session).get('error')
  let nativeWorkflowSettlement = context.get(Session).get('nativeWorkflowSettlement')
  return context.render(
    <Document {...documentAssetHrefs} title={documentTitle}>
      <AppShell
        currentUserId={user(context).user.id}
        mode={options.mode}
        homeHref={routes.workspace.home.href()}
        switchHref={options.mode === 'shift' ? routes.workspace.individual.href() : routes.workspace.shiftSelection.href()}
        inboxHref={routes.workspace.inbox.href()}
        inboxCount={navigation.inbox.length}
        inboxActive={context.url.pathname === routes.workspace.inbox.href()}
        privacySettingsHref={routes.settings.privacy.index.href()}
        privacyMode={privacyMode}
        signInHref={routes.auth.signIn.index.href()}
        signOutAction={routes.auth.signOut.href()}
        workspaceFrameSrc={context.url.pathname + context.url.search}
        error={typeof error === 'string' ? error : undefined}
        processingStateHref={routes.resources.processingAll.href()}
        processingEventsHref={routes.resources.processingEvents.href()}
        analyticsAction={process.env.USABILITY_ANALYTICS_ENABLED?.toLowerCase() === 'false' ? undefined : routes.resources.analytics.href()}
        nativeWorkflowSettlement={nativeWorkflowSettlement === 'complete' || nativeWorkflowSettlement === 'error' ? nativeWorkflowSettlement : undefined}
        csrfToken={csrfToken}
      />
    </Document>,
  )
}

function isWorkspaceFrame(context: any) {
  return context.request.headers.get('X-Remix-Target') === 'workspace'
}

async function renderWorkspaceDocument(context: any, options: { mode: 'shift' | 'individual'; title: string }) {
  return renderWorkspace(context, null, {
    ...options,
    breadcrumbs: [],
  })
}

function notFound(context: any) {
  return context.render(
    <Document {...documentAssetHrefs} title="Not found · Handover AI"><NotFoundPage homeHref={routes.workspace.home.href()} /></Document>,
    { status: 404 },
  )
}

async function handoverPage(context: any, shiftId: string | null, tab: ReviewTab) {
  if (!isWorkspaceFrame(context)) {
    return renderWorkspaceDocument(context, { mode: shiftId ? 'shift' : 'individual', title: 'Handover' })
  }
  let db = context.get(DataRuntimeKey).db
  let session = user(context)
  let handover = await getHandoverForUser(db, context.params.handoverId, session.user.id)
  if (!handover || (shiftId && !isHandoverRelatedToShift(handover, shiftId))) return notFound(context)
  let flashedMetadataForm = context.get(Session).get(`metadataForm:${handover.id}`)
  let metadataFormState = flashedMetadataForm && typeof flashedMetadataForm === 'object' && !Array.isArray(flashedMetadataForm)
    ? flashedMetadataForm as {
      participants: string
      patients: Array<{ patientKey: string; displayName: string; location: string }>
      errors: { form?: string; participants?: string; patients?: Array<{ displayName?: string; location?: string }> }
    }
    : undefined
  let analysis = normalizeReviewAnalysis(handover.analysis)
  let reviewPatient = handover.linked_patient_key
    ? {
        patientKey: handover.linked_patient_key,
        displayName: handover.linked_patient_display_name ?? handover.linked_patient_key,
        location: handover.linked_patient_location ?? undefined,
      }
    : analysis?.patients.length === 1
      ? analysis.patients[0]
      : undefined
  let [allTasks, users, linkedShift, pendingAssignments, availableShifts, shiftSheetPatients, transcriptPrivacy, transcriptPrivacyExpected] = await Promise.all([
    listTasksForUser(db, session.user.id),
    listUsers(db),
    shiftId ? getShiftForUser(db, shiftId, session.user.id) : Promise.resolve(null),
    listPendingAssignmentsForUser(db, session.user.id),
    listShiftsForUser(db, session.user.id),
    shiftId
      ? listShiftSheetPatientsForUser(db, { shiftId, userId: session.user.id })
      : Promise.resolve([]),
    tab === 'transcript'
      ? getHandoverTranscriptPrivacyAuditForUser(db, { handoverId: handover.id, userId: session.user.id })
      : Promise.resolve(null),
    tab === 'transcript'
      ? handoversHaveLocalFirstProcessingHistory(
          db,
          [handover.id, handover.source_handover_id ?? ''],
        )
      : Promise.resolve(false),
  ])
  if (shiftId && !linkedShift) return notFound(context)
  let reviewPatientWorkspaceKey = reviewPatient
    ? canonicalPatientWorkspaceKey(reviewPatient, shiftSheetPatients)
    : undefined
  let tasks = allTasks.filter((task) => task.handover_id === handover.id)
  let persistedTaskModels: TaskSummary[] = tasks.map((task) => ({
    id: task.id,
    label: task.title,
    completed: task.status === 'done',
    due: task.due_label,
    dueAt: task.due_at?.toISOString(),
    reminderEnabled: task.reminder_enabled,
    updateAction: `${routes.actions.updateTask.href({ taskId: task.id })}?returnTo=${encodeURIComponent(context.url.pathname)}`,
    deleteAction: `${routes.actions.deleteTask.href({ taskId: task.id })}?returnTo=${encodeURIComponent(context.url.pathname)}`,
    handoverId: handover.id,
    patientKey: task.patient_key,
    relatedUncertaintyId: task.related_uncertainty_id ?? undefined,
  }))
  // handover_tasks is authoritative after analysis persistence, including an
  // intentionally empty result. Falling back to analysis JSON here resurrects
  // the final deleted action even though its mutation succeeded in the table.
  let taskModels = persistedTaskModels
  let summary = handoverSummary(handover, shiftId)
  let transcriptionMetadata = normalizeTranscriptionMetadata(handover.transcription_metadata)
  let inboxAssignment = pendingAssignments.find((assignment) => assignment.handover_id === handover.id)
  let sourceShift = availableShifts.find((shift) => shift.id === (handover.source_shift_id ?? handover.shift_id))
  let sourceRoute = handover.destination_department
    ? `${handover.source_department} -> ${handover.destination_department}`
    : handover.source_department || 'Route not recorded'
  summary.routeLabel = sourceRoute
  let returnTo = encodeURIComponent(context.url.pathname)
  let completed = handover.processing_status === 'completed'
  let readiness = analysis?.analysisReadiness ?? {}
  let hasAnalysis = Boolean(analysis)
  let supportedTabs: Record<ReviewTab, boolean> = {
    details: true,
    checklist: hasAnalysis && (completed || readiness.checklist === true),
    summary: hasAnalysis && (completed || readiness.summary === true),
    uncertainty: hasAnalysis && (completed || readiness.uncertainty === true),
    tasks: hasAnalysis && (completed || readiness.actions === true),
    communication: hasAnalysis && (completed || readiness.communication === true),
    transcript: Boolean(
      handover.transcript.trim()
      && ['analysing', 'completed', 'failed'].includes(handover.processing_status),
    ),
  }
  if (!supportedTabs[tab]) {
    let processing = handover.processing_status !== 'completed' && handover.processing_status !== 'failed'
    let fallbackTab: ReviewTab = processing ? 'details' : supportedTabs.checklist ? 'checklist' : 'details'
    return redirect(reviewHref({ shiftId, handoverId: handover.id, reviewTab: fallbackTab }), 303)
  }
  let tabLabels: Record<ReviewTab, string> = {
    details: 'Details',
    checklist: 'Checklist',
    summary: 'SBAR summary',
    uncertainty: 'Uncertainty',
    tasks: 'Actions',
    communication: 'Communication',
    transcript: 'Transcript',
  }
  let content = (
    <HandoverReviewPage
      handover={summary}
      tabs={reviewTabs.map((key) => ({
        key,
        label: tabLabels[key],
        href: reviewHref({ shiftId, handoverId: handover.id, reviewTab: key }),
        count: key === 'tasks' ? taskModels.length : undefined,
        disabled: !supportedTabs[key],
      }))}
      activeTab={tab}
      analysis={analysis}
      transcriptionMetadata={transcriptionMetadata}
      transcript={handover.transcript}
      transcriptPrivacy={transcriptPrivacy}
      transcriptPrivacyExpected={transcriptPrivacyExpected}
      transcriptPrivacyAllowAction={`${routes.actions.allowPrivacyFindings.href({ handoverId: handover.id })}?returnTo=${returnTo}`}
      transcriptPrivacyAnalysisStale={transcriptPrivacy?.rerunRequired ?? false}
      rerunAnalysisAction={`${routes.actions.reanalyzeHandover.href({ handoverId: handover.id })}?returnTo=${returnTo}`}
      tasks={taskModels}
      contextType={handover.context_type}
      consentMode={handover.consent_mode}
      participants={participantNames(handover.participants)}
      patientKey={reviewPatient?.patientKey}
      patientDisplayName={reviewPatient?.displayName}
      patientLocation={reviewPatient?.location}
      patientWorkspaceHref={shiftId && reviewPatientWorkspaceKey
        ? routes.workspace.patient.href({ shiftId, patientKey: reviewPatientWorkspaceKey })
        : undefined}
      patientActionsHref={shiftId && reviewPatientWorkspaceKey
        ? patientWorkspaceHref({ shiftId, patientKey: reviewPatientWorkspaceKey, tab: 'actions' })
        : undefined}
      editPatientDetails={context.url.searchParams.get('edit') === 'patient'}
      metadataFormState={metadataFormState}
      processingStartedAt={handover.processing_started_at instanceof Date ? handover.processing_started_at.toISOString() : handover.processing_started_at ? String(handover.processing_started_at) : undefined}
      interactionsDisabled={handover.processing_status !== 'completed'}
      metadataAction={`${routes.actions.updateMetadata.href({ handoverId: handover.id })}?returnTo=${returnTo}`}
      checklistAction={`${routes.actions.updateChecklist.href({ handoverId: handover.id })}?returnTo=${returnTo}`}
      summaryAction={`${routes.actions.updateSummary.href({ handoverId: handover.id })}?returnTo=${returnTo}`}
      summaryReviewAction={`${routes.actions.updateSummaryReview.href({ handoverId: handover.id })}?returnTo=${returnTo}`}
      assignmentAction={`${routes.actions.createAssignments.href()}?returnTo=${returnTo}`}
      extendAction={`${routes.actions.extendHandover.href({ handoverId: handover.id })}?returnTo=${returnTo}`}
      recipients={users.filter((candidate) => candidate.id !== session.user.id).map((candidate) => ({ id: candidate.id, label: candidate.full_name, description: `${candidate.occupation} · ${candidate.department}` }))}
      taskAction={`${routes.actions.createTask.href({ handoverId: handover.id })}?returnTo=${returnTo}`}
      uncertaintyTaskActions={Object.fromEntries((analysis?.patients ?? []).flatMap((patient) =>
        patient.uncertainties.map((uncertainty) => [
          uncertainty.id,
          `${routes.actions.createUncertaintyTask.href({ handoverId: handover.id, uncertaintyId: uncertainty.id })}?returnTo=${returnTo}`,
        ]),
      ))}
      viewerPerspective={handoverViewerPerspective({ handover, shiftId, userId: session.user.id, inboxAssignment })}
      retryAction={handover.processing_status === 'failed' ? `${routes.actions.retryHandover.href({ handoverId: handover.id })}?returnTo=${returnTo}` : undefined}
      discardFailedAction={handover.processing_status === 'failed' ? `${routes.actions.discardFailedHandover.href({ handoverId: handover.id })}?returnTo=${returnTo}` : undefined}
      deleteAction={routes.actions.deleteHandover.href({ handoverId: handover.id })}
      inboxPlacement={inboxAssignment ? {
        action: routes.actions.placeAssignment.href({ assignmentId: inboxAssignment.id }),
        assignmentTitle: handover.title,
        assignedBy: users.find((candidate) => candidate.id === inboxAssignment.assigned_by_user_id)?.full_name ?? 'Unknown sender',
        sourceLabel: sourceShift ? `${sourceShift.title} · ${sourceShift.department}` : sourceRoute,
        shifts: availableShifts.map((shift) => ({ id: shift.id, title: shift.title, department: shift.department })),
      } : undefined}
      csrfToken={getCsrfToken(context)}
    />
  )
  let breadcrumbs = shiftId && reviewPatientWorkspaceKey
    ? []
    : shiftId && linkedShift
    ? workspaceBreadcrumbs(
      { label: 'Shifts', href: routes.workspace.shiftSelection.href() },
      { label: linkedShift.title, href: routes.workspace.shift.href({ shiftId }) },
      { label: handover.title },
    )
    : workspaceBreadcrumbs(
      { label: 'Handovers', href: routes.workspace.individual.href(), document: true },
      { label: handover.title },
    )
  return renderWorkspace(context, content, {
    mode: shiftId ? 'shift' : 'individual',
    currentHandoverId: handover.id,
    title: `${handover.title} · ${tabLabels[tab]}`,
    breadcrumbs,
  })
}

export default createController(routes.workspace, {
  middleware: [requireUser(), ...publicFormMiddleware],
  actions: {
    home(context) {
      let csrfToken = getCsrfToken(context)
      return context.render(
        <Document {...documentAssetHrefs} title="Choose workflow · Handover AI">
          <ModeHomePage
            session={user(context)}
            shiftHref={routes.workspace.shiftSelection.href()}
            individualHref={routes.workspace.individual.href()}
            signOutAction={routes.auth.signOut.href()}
            csrfToken={csrfToken}
            analyticsAction={process.env.USABILITY_ANALYTICS_ENABLED?.toLowerCase() === 'false' ? undefined : routes.resources.analytics.href()}
          />
        </Document>,
      )
    },
    async individual(context) {
      if (!isWorkspaceFrame(context)) return renderWorkspaceDocument(context, { mode: 'individual', title: 'Individual handovers' })
      let navigation = await shellData(context)
      let session = user(context)
      let pendingInboxHandoverIds = new Set(navigation.inbox.map((assignment) => assignment.id))
      return renderWorkspace(
        context,
        <IndividualPage
          handovers={navigation.handovers.filter((handover) =>
            !handover.shiftId && !pendingInboxHandoverIds.has(handover.id),
          )}
          createAction={routes.actions.createHandover.href()}
          csrfToken={getCsrfToken(context)}
          shifts={navigation.shifts}
          session={session}
        />,
        {
          mode: 'individual',
          title: 'Individual handovers',
          breadcrumbs: workspaceBreadcrumbs({ label: 'Handovers' }),
        },
      )
    },
    async inbox(context) {
      if (!isWorkspaceFrame(context)) return renderWorkspaceDocument(context, { mode: 'individual', title: 'Inbox' })
      let navigation = await shellData(context)
      let content = <InboxPage assignments={navigation.inbox} shifts={navigation.shifts} csrfToken={getCsrfToken(context)} startShiftHref={routes.workspace.shiftSelection.href()} />
      return renderWorkspace(context, content, {
        mode: 'individual',
        title: 'Inbox',
        breadcrumbs: workspaceBreadcrumbs({ label: 'Inbox' }),
      })
    },
    handover(context) {
      return redirectToDefaultHandoverTab(context, null)
    },
    handoverReview(context) {
      let tab = normalizeReviewTab(context.params.reviewTab)
      if (!tab) return redirectToDefaultHandoverTab(context, null)
      if (tab !== context.params.reviewTab) return redirect(reviewHref({ handoverId: context.params.handoverId, reviewTab: tab }), 303)
      return handoverPage(context, null, tab)
    },
    async shiftSelection(context) {
      if (!isWorkspaceFrame(context)) return renderWorkspaceDocument(context, { mode: 'shift', title: 'Choose a shift' })
      let session = user(context)
      let navigation = await shellData(context)
      let content = <ShiftSelectionPage
        shifts={navigation.shifts}
        newShiftAction={routes.actions.createShift.href()}
        defaultTitle="Day shift"
        defaultDepartment={session.user.department}
        assignedUserId={session.user.id}
        csrfToken={getCsrfToken(context)}
      />
      return renderWorkspace(context, content, {
        mode: 'shift',
        title: 'Choose a shift',
        breadcrumbs: workspaceBreadcrumbs({ label: 'Shifts' }),
      })
    },
    async shift(context) {
      if (!isWorkspaceFrame(context)) return renderWorkspaceDocument(context, { mode: 'shift', title: 'Shift' })
      let db = context.get(DataRuntimeKey).db
      let session = user(context)
      let userId = session.user.id
      let [shift, handovers, sheetPatients, handoverPatients, tasks] = await Promise.all([
        getShiftForUser(db, context.params.shiftId, userId),
        listHandoversForUser(db, userId),
        listShiftSheetPatientsForUser(db, { shiftId: context.params.shiftId, userId }),
        listShiftHandoverPatientsForUser(db, { shiftId: context.params.shiftId, userId }),
        listTasksForUser(db, userId),
      ])
      if (!shift) return notFound(context)
      let model = shiftSummary(shift, handovers, sheetPatients ?? [], handoverPatients, tasks)
      return renderWorkspace(
        context,
        <ShiftBoardPage
          shift={model}
          patients={model.patients}
          createHandoverAction={routes.actions.createHandover.href()}
          importSheetAction={routes.actions.importHandoverSheet.href({ shiftId: shift.id })}
          orderAction={routes.actions.orderPatients.href({ shiftId: shift.id })}
          prioritiseAction={routes.actions.prioritiseShift.href({ shiftId: shift.id })}
          deleteAction={routes.actions.deleteShift.href({ shiftId: shift.id })}
          session={session}
          csrfToken={getCsrfToken(context)}
        />,
        {
          mode: 'shift',
          title: shift.title,
          breadcrumbs: workspaceBreadcrumbs(
            { label: 'Shifts', href: routes.workspace.shiftSelection.href() },
            { label: shift.title },
          ),
        },
      )
    },
    patient(context) {
      return patientPage(context, 'handover-sheet')
    },
    patientTab(context) {
      let tab = normalizePatientWorkspaceTab(context.params.patientWorkspaceTab)
      if (!tab) return redirect(routes.workspace.patient.href({ shiftId: context.params.shiftId, patientKey: context.params.patientKey }), 303)
      if (tab === 'handover-sheet') return redirect(routes.workspace.patient.href({ shiftId: context.params.shiftId, patientKey: context.params.patientKey }), 303)
      return patientPage(context, tab)
    },
    patientAction(context) {
      if (context.params.patientWorkspaceTab !== 'actions') return redirect(routes.workspace.patient.href({ shiftId: context.params.shiftId, patientKey: context.params.patientKey }), 303)
      if (context.params.patientWorkspaceActionRoute !== 'add') return redirect(patientWorkspaceHref({ shiftId: context.params.shiftId, patientKey: context.params.patientKey, tab: 'actions' }), 303)
      return patientPage(context, 'actions', 'add')
    },
    shiftHandover(context) {
      return redirectToDefaultHandoverTab(context, context.params.shiftId)
    },
    shiftHandoverReview(context) {
      let tab = normalizeReviewTab(context.params.reviewTab)
      if (!tab) return redirectToDefaultHandoverTab(context, context.params.shiftId)
      if (tab !== context.params.reviewTab) return redirect(reviewHref({ shiftId: context.params.shiftId, handoverId: context.params.handoverId, reviewTab: tab }), 303)
      return handoverPage(context, context.params.shiftId, tab)
    },
  },
})

async function patientPage(context: any, tab: 'handover-sheet' | 'actions', actionRoute?: 'add') {
  if (!isWorkspaceFrame(context)) return renderWorkspaceDocument(context, { mode: 'shift', title: 'Patient workspace' })
  let db = context.get(DataRuntimeKey).db
  let session = user(context)
  let userId = session.user.id
  let [shift, sheetPatients, handovers, tasks, clinicalPatients] = await Promise.all([
    getShiftForUser(db, context.params.shiftId, userId),
    listShiftSheetPatientsForUser(db, { shiftId: context.params.shiftId, userId }),
    listHandoversForUser(db, userId),
    listTasksForUser(db, userId),
    listShiftHandoverPatientsForUser(db, { shiftId: context.params.shiftId, userId }),
  ])
  if (!shift) return notFound(context)
  let shiftModel = buildShiftWorkspaceReadModel({
    shift,
    handovers,
    sheetPatients,
    handoverPatients: clinicalPatients,
    tasks,
  })
  let patientModel = resolveWorkspacePatientReadModel(shiftModel.patients, context.params.patientKey)
  if (!patientModel) return notFound(context)
  let sheetPatient = patientModel.sheetPatient
  let patientKey = patientModel.key
  let clinicalRows = patientModel.clinicalRows
  let availablePatientHandovers = patientModel.handovers.map((handover) => handover.row)
  let handoverSummaries = patientModel.handovers.map((handover) => handoverSummaryFromReadModel(handover, shift.id))
  let processingHandovers = patientModel.processingHandovers.map((handover) => handoverSummaryFromReadModel(handover, shift.id))
  let latestClinicalRow = clinicalRows[0]
  let latestHandoverId = patientModel.handovers.toSorted((left, right) =>
    new Date(right.row.updated_at).getTime() - new Date(left.row.updated_at).getTime()
  )[0]?.row.id
  let patientHandovers = [...availablePatientHandovers, ...patientModel.processingHandovers.map((handover) => handover.row)]
  let patient: PatientSummary = {
    key: patientKey,
    displayName: sheetPatient?.display_name ?? latestClinicalRow?.display_name ?? patientHandovers.find((handover) => handover.linked_patient_display_name)?.linked_patient_display_name ?? patientKey,
    bed: sheetPatient?.location ?? latestClinicalRow?.location ?? patientHandovers.find((handover) => handover.linked_patient_location)?.linked_patient_location ?? undefined,
    href: routes.workspace.patient.href({ shiftId: shift.id, patientKey }),
    handoverCount: patientModel.handovers.length,
    latestHandoverId,
    openTaskCount: patientModel.openTaskCount,
    handovers: handoverSummaries,
    processingHandovers,
    hasSheet: Boolean(sheetPatient),
  }
  let manualWorksheetFields = patientHandovers
    .toSorted((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())
    .map((handover) => patientWorksheetFieldsFromAnalysis(handover.analysis, patientKey))
    .find((candidate) => candidate.length > 0) ?? []
  let fields = buildPatientWorksheetFields(sheetPatient?.fields ?? manualWorksheetFields, {
    displayName: patient.displayName,
    location: patient.bed,
  })
  let patientHandover = availablePatientHandovers.find((handover) => handover.processing_status === 'completed') ?? availablePatientHandovers[0]
  let patientTaskIds = new Set(patientModel.taskIds)
  let patientTasks: TaskSummary[] = tasks.filter((task) => patientTaskIds.has(task.id)).map((task) => {
    let taskHandover = handoverSummaries.find((handover) => handover.id === task.handover_id)
    return {
      id: task.id,
      label: task.title,
      completed: task.status === 'done',
      due: task.due_label,
      dueAt: task.due_at?.toISOString(),
      priority: task.priority === 'urgent' ? 'urgent' : 'routine',
      reminderEnabled: task.reminder_enabled,
      updateAction: `${routes.actions.updateTask.href({ taskId: task.id })}?returnTo=${encodeURIComponent(context.url.pathname)}`,
      deleteAction: `${routes.actions.deleteTask.href({ taskId: task.id })}?returnTo=${encodeURIComponent(context.url.pathname)}`,
      handoverId: task.handover_id,
      patientKey: patientModel.key,
      handoverDirection: taskHandover?.direction,
      handoverUpdatedAt: taskHandover?.updatedAt,
    }
  })
  let tabs = patientWorkspaceTabs.map((key) => ({
    key: key === 'handover-sheet' ? 'sheet' : key,
    label: key === 'handover-sheet' ? 'Handover sheet' : 'Actions',
    href: patientWorkspaceHref({ shiftId: shift.id, patientKey, tab: key }),
  }))
  let patientActionsHref = patientWorkspaceHref({
    shiftId: shift.id,
    patientKey,
    tab: 'actions',
  })
  return renderWorkspace(context, <PatientWorkspacePage
    patient={patient}
    shift={{ id: shift.id, title: shift.title, department: shift.department, href: routes.workspace.shift.href({ shiftId: shift.id }) }}
    createHandoverAction={routes.actions.createHandover.href()}
    session={session}
    actionRoute={actionRoute}
    actionsHref={patientActionsHref}
    addActionHref={patientWorkspaceActionHref({ shiftId: shift.id, patientKey, tab: 'actions', action: 'add' })}
    tabs={tabs}
    activeTab={tab === 'handover-sheet' ? 'sheet' : 'actions'}
    sheetFields={fields.map((field) => ({
      ...field,
      reviewAction: routes.actions.reviewPatientField.href({
        shiftId: shift.id,
        patientKey,
        fieldKey: field.key,
      }),
      sbarUpdateEvents: field.sbarUpdateEvents.map((event) => ({
        ...event,
        sourceHref: reviewHref({
          shiftId: shift.id,
          handoverId: event.handoverId,
          reviewTab: 'summary',
        }),
      })),
    }))}
    actions={patientTasks}
    saveAction={routes.actions.reviewPatientDetails.href({ shiftId: shift.id, patientKey })}
    createActionAction={patientHandover ? `${routes.actions.createTask.href({ handoverId: patientHandover.id })}?returnTo=${encodeURIComponent(patientActionsHref)}` : undefined}
    csrfToken={getCsrfToken(context)}
  />, {
    mode: 'shift',
    title: `${patient.displayName} · ${actionRoute === 'add' ? 'Add action' : tab === 'actions' ? 'Actions' : 'Handover sheet'}`,
    breadcrumbs: [],
  })
}
