import { form, get, post, route } from 'remix/routes'

/**
 * The complete public HTTP contract for Handover AI.
 *
 * Document routes intentionally keep the URLs from the React application. Browser
 * mutations use ordinary forms under /actions; only operational checks, polling,
 * analytics, and upload extraction are resource responses.
 */
export const routes = route({
  assets: get('/assets/*path'),
  health: get('/health'),
  apiHealth: get('/api/health'),
  ready: get('/ready'),
  apiReady: get('/api/ready'),

  auth: route('auth', {
    signIn: form('sign-in'),
    register: form('register'),
    signOut: post('sign-out'),
  }),

  settings: route('settings', {
    privacy: form('privacy'),
  }),

  workspace: {
    home: get('/'),
    individual: get('/individual'),
    inbox: get('/inbox'),
    handover: get('/handover/:handoverId'),
    handoverReview: get('/handover/:handoverId/:reviewTab'),
    shiftSelection: get('/shift'),
    shift: get('/shift/:shiftId'),
    patient: get('/shift/:shiftId/patients/:patientKey'),
    patientTab: get('/shift/:shiftId/patients/:patientKey/:patientWorkspaceTab'),
    patientAction: get(
      '/shift/:shiftId/patients/:patientKey/:patientWorkspaceTab/:patientWorkspaceActionRoute',
    ),
    shiftHandover: get('/shift/:shiftId/handover/:handoverId'),
    shiftHandoverReview: get('/shift/:shiftId/handover/:handoverId/:reviewTab'),
  },

  actions: route('actions', {
    createShift: post('shifts'),
    deleteShift: post('shifts/:shiftId/delete'),
    updateShiftPatient: post('shifts/:shiftId/patients/:patientKey'),
    orderPatients: post('shifts/:shiftId/patient-order'),
    prioritiseShift: post('shifts/:shiftId/prioritise'),
    createHandover: post('handovers'),
    deleteHandover: post('handovers/:handoverId/delete'),
    discardFailedHandover: post('handovers/:handoverId/discard-failed-attempt'),
    extendHandover: post('handovers/:handoverId/extend'),
    retryHandover: post('handovers/:handoverId/retry-processing'),
    allowPrivacyFindings: post('handovers/:handoverId/privacy-exceptions'),
    reanalyzeHandover: post('handovers/:handoverId/reanalyze'),
    updateMetadata: post('handovers/:handoverId/metadata'),
    updateChecklist: post('handovers/:handoverId/checklist'),
    updateSummary: post('handovers/:handoverId/summary'),
    updateSummaryReview: post('handovers/:handoverId/summary-review'),
    createTask: post('handovers/:handoverId/tasks'),
    createUncertaintyTask: post(
      'handovers/:handoverId/uncertainties/:uncertaintyId/tasks',
    ),
    updateTask: post('tasks/:taskId'),
    deleteTask: post('tasks/:taskId/delete'),
    createAssignments: post('handover-assignments'),
    placeAssignment: post('handover-assignments/:assignmentId/place'),
    addAssignmentToIndividual: post('handover-assignments/:assignmentId/individual'),
    dismissAssignment: post('handover-assignments/:assignmentId/dismiss'),
    importHandoverSheet: post('shifts/:shiftId/handover-sheet'),
    reviewPatientDetails: post(
      'shifts/:shiftId/patients/:patientKey/handover-sheet/details',
    ),
    reviewPatientField: post(
      'shifts/:shiftId/patients/:patientKey/handover-sheet/fields/:fieldKey',
    ),
  }),

  resources: route('resources', {
    processingAll: get('processing/handovers'),
    processingEvents: get('processing/handovers/events'),
    processing: get('handovers/:handoverId/processing'),
    analytics: post('analytics/usability'),
    extractHandoverSheet: post('handover-sheet/extract'),
    release: get('release'),
  }),

})

export const reviewTabs = [
  'details',
  'checklist',
  'summary',
  'uncertainty',
  'tasks',
  'communication',
  'transcript',
] as const

export type ReviewTab = (typeof reviewTabs)[number]
export const defaultReviewTab: ReviewTab = 'checklist'

export const reviewTabAliases: Readonly<Record<string, ReviewTab>> = {
  action: 'tasks',
  actions: 'tasks',
  sbar: 'summary',
}

export const patientWorkspaceTabs = ['handover-sheet', 'actions'] as const
export type PatientWorkspaceTab = (typeof patientWorkspaceTabs)[number]
export const patientWorkspaceActionRoutes = ['add'] as const
export type PatientWorkspaceActionRoute = (typeof patientWorkspaceActionRoutes)[number]

export function normalizeReviewTab(value: string | undefined): ReviewTab | null {
  if (reviewTabs.includes(value as ReviewTab)) return value as ReviewTab
  return value ? (reviewTabAliases[value] ?? null) : null
}

export function normalizePatientWorkspaceTab(
  value: string | undefined,
): PatientWorkspaceTab | null {
  return patientWorkspaceTabs.includes(value as PatientWorkspaceTab)
    ? (value as PatientWorkspaceTab)
    : null
}

export function reviewHref(params: {
  handoverId: string
  reviewTab: ReviewTab
  shiftId?: string | null
}): string {
  return params.shiftId
    ? routes.workspace.shiftHandoverReview.href({
        shiftId: params.shiftId,
        handoverId: params.handoverId,
        reviewTab: params.reviewTab,
      })
    : routes.workspace.handoverReview.href({
        handoverId: params.handoverId,
        reviewTab: params.reviewTab,
      })
}

export function patientWorkspaceHref(params: {
  shiftId: string
  patientKey: string
  tab: PatientWorkspaceTab
}): string {
  return params.tab === 'handover-sheet'
    ? routes.workspace.patient.href({
        shiftId: params.shiftId,
        patientKey: params.patientKey,
      })
    : routes.workspace.patientTab.href({
        shiftId: params.shiftId,
        patientKey: params.patientKey,
        patientWorkspaceTab: params.tab,
      })
}

export function patientWorkspaceActionHref(params: {
  shiftId: string
  patientKey: string
  tab: Extract<PatientWorkspaceTab, 'actions'>
  action: PatientWorkspaceActionRoute
}): string {
  return routes.workspace.patientAction.href({
    shiftId: params.shiftId,
    patientKey: params.patientKey,
    patientWorkspaceTab: params.tab,
    patientWorkspaceActionRoute: params.action,
  })
}

const analyticsRouteSentinel = 'analytics-id'

const staticAnalyticsRoutes = new Set([
  routes.workspace.home.href(),
  routes.workspace.individual.href(),
  routes.workspace.inbox.href(),
  routes.workspace.shiftSelection.href(),
  routes.auth.signIn.index.href(),
  routes.auth.register.index.href(),
  routes.auth.signOut.href(),
  routes.settings.privacy.index.href(),
  routes.health.href(),
  routes.ready.href(),
  routes.apiHealth.href(),
  routes.apiReady.href(),
  routes.resources.processingAll.href(),
  routes.resources.processingEvents.href(),
  routes.resources.analytics.href(),
  routes.resources.extractHandoverSheet.href(),
  routes.resources.release.href(),
  routes.actions.createShift.href(),
  routes.actions.createHandover.href(),
  routes.actions.createAssignments.href(),
])

type AnalyticsDynamicRoute = {
  pattern: RegExp
  redacted: string
}

function analyticsDynamicRoute(href: string, canonicalHref = href): AnalyticsDynamicRoute {
  let escapedHref = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return {
    pattern: new RegExp(`^${escapedHref.replaceAll(analyticsRouteSentinel, '[^/]+')}$`),
    redacted: canonicalHref.replaceAll(analyticsRouteSentinel, ':id'),
  }
}

const analyticsReviewRouteSegments = [...reviewTabs, ...Object.keys(reviewTabAliases)]
const analyticsDynamicRoutes: AnalyticsDynamicRoute[] = [
  analyticsDynamicRoute(routes.workspace.handover.href({
    handoverId: analyticsRouteSentinel,
  })),
  ...analyticsReviewRouteSegments.flatMap((reviewTab) => {
    let canonicalTab = normalizeReviewTab(reviewTab)!
    return [
      analyticsDynamicRoute(
        routes.workspace.handoverReview.href({
          handoverId: analyticsRouteSentinel,
          reviewTab,
        }),
        routes.workspace.handoverReview.href({
          handoverId: analyticsRouteSentinel,
          reviewTab: canonicalTab,
        }),
      ),
      analyticsDynamicRoute(
        routes.workspace.shiftHandoverReview.href({
          shiftId: analyticsRouteSentinel,
          handoverId: analyticsRouteSentinel,
          reviewTab,
        }),
        routes.workspace.shiftHandoverReview.href({
          shiftId: analyticsRouteSentinel,
          handoverId: analyticsRouteSentinel,
          reviewTab: canonicalTab,
        }),
      ),
    ]
  }),
  analyticsDynamicRoute(routes.workspace.shift.href({
    shiftId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.workspace.patient.href({
    shiftId: analyticsRouteSentinel,
    patientKey: analyticsRouteSentinel,
  })),
  ...patientWorkspaceTabs.map((patientWorkspaceTab) => analyticsDynamicRoute(
    routes.workspace.patientTab.href({
      shiftId: analyticsRouteSentinel,
      patientKey: analyticsRouteSentinel,
      patientWorkspaceTab,
    }),
  )),
  analyticsDynamicRoute(routes.workspace.patientAction.href({
    shiftId: analyticsRouteSentinel,
    patientKey: analyticsRouteSentinel,
    patientWorkspaceTab: 'actions',
    patientWorkspaceActionRoute: 'add',
  })),
  analyticsDynamicRoute(routes.workspace.shiftHandover.href({
    shiftId: analyticsRouteSentinel,
    handoverId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.deleteShift.href({
    shiftId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.updateShiftPatient.href({
    shiftId: analyticsRouteSentinel,
    patientKey: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.orderPatients.href({
    shiftId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.prioritiseShift.href({
    shiftId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.deleteHandover.href({
    handoverId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.discardFailedHandover.href({
    handoverId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.extendHandover.href({
    handoverId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.retryHandover.href({
    handoverId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.allowPrivacyFindings.href({
    handoverId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.reanalyzeHandover.href({
    handoverId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.updateMetadata.href({
    handoverId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.updateChecklist.href({
    handoverId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.updateSummary.href({
    handoverId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.updateSummaryReview.href({
    handoverId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.createTask.href({
    handoverId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.createUncertaintyTask.href({
    handoverId: analyticsRouteSentinel,
    uncertaintyId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.updateTask.href({
    taskId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.deleteTask.href({
    taskId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.placeAssignment.href({
    assignmentId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.addAssignmentToIndividual.href({
    assignmentId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.dismissAssignment.href({
    assignmentId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.importHandoverSheet.href({
    shiftId: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.reviewPatientDetails.href({
    shiftId: analyticsRouteSentinel,
    patientKey: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.actions.reviewPatientField.href({
    shiftId: analyticsRouteSentinel,
    patientKey: analyticsRouteSentinel,
    fieldKey: analyticsRouteSentinel,
  })),
  analyticsDynamicRoute(routes.resources.processing.href({
    handoverId: analyticsRouteSentinel,
  })),
]

/**
 * Redact every route parameter while accepting only URL shapes declared above.
 * Unknown paths collapse closed so future route segments cannot leak content.
 */
export function sanitizeAnalyticsRoute(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/unknown'
  let pathname = value.split(/[?#]/, 1)[0]!.replace(/\/+$/, '') || routes.workspace.home.href()
  if (staticAnalyticsRoutes.has(pathname)) return pathname
  return analyticsDynamicRoutes.find((route) => route.pattern.test(pathname))?.redacted ?? '/unknown'
}
