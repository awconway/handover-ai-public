import type {
  AnalysisSummary,
  HandoverAnalysisResult,
  PatientProjection,
  PersistedChecklistItem,
  PersistedHandoverAnalysis,
  PersistedPatientAnalysis,
  PersistedTask,
  PersistedUncertainty,
  TaskProjection,
} from './handover-analysis.server.ts'

const SBAR_PLACEHOLDERS = new Set([
  'not mentioned in supplied evidence.',
  'not mentioned in extracted evidence.',
])

const checklistStatusRank: Record<PersistedChecklistItem['status'], number> = {
  missing: 0,
  partial: 1,
  addressed: 2,
}

const interruptionStatusRank: Record<
  PersistedHandoverAnalysis['interruptionAssessment']['status'],
  number
> = {
  none: 0,
  possible: 1,
  confirmed: 2,
}

type PatientMergeSource = {
  incomingKey: string | null
}

export type CreateReviewMetadata = {
  title: string
  participants: string[]
  participantsEdited: boolean
  linkedPatientKey: string | null
  linkedPatientDisplayName: string | null
  linkedPatientLocation: string | null
}

export type PreservedCreateReviewMetadata = {
  result: HandoverAnalysisResult
  titleOverride: string | null
  participantsOverride: string[] | null
}

/**
 * Merges a newly analysed extension into the state already reviewed by a clinician.
 *
 * The projection arrays are part of the input deliberately: database task rows are
 * the authoritative copy of task edits and manual tasks, while the analysis JSON can
 * be stale after those edits. Passing the persisted rows prevents an extension from
 * reviving deleted tasks or overwriting task status, reminders, and links.
 */
export function mergeHandoverContinuation(
  existing: HandoverAnalysisResult,
  incoming: HandoverAnalysisResult,
): HandoverAnalysisResult {
  let existingTasksByPatient = groupTasks(existing.taskProjections)
  let incomingTasksByPatient = groupTasks(incoming.taskProjections)
  let currentPatients = existing.analysis.patients.map((patient) => {
    let state = mergeTasksAndUncertainties(
      cloneTasks(existingTasksByPatient.get(patient.patientKey) ?? []),
      [],
      patient.uncertainties,
      [],
    )
    return { ...clonePatient(patient), ...state }
  })
  let currentPatientMap = buildPatientLookup(currentPatients)
  let mergedPatients = [...currentPatients]
  let mergedIndexByKey = new Map(
    mergedPatients.map((patient, index) => [patient.patientKey, index]),
  )
  let incomingKeyRemap = new Map<string, string>()
  let sourceByPatientKey = new Map<string, PatientMergeSource>(
    mergedPatients.map((patient) => [patient.patientKey, { incomingKey: null }]),
  )

  for (let incomingPatient of incoming.analysis.patients) {
    let currentPatient = findPatientMatch(currentPatients, currentPatientMap, incomingPatient)

    if (!currentPatient) {
      if (isPlaceholderPatient(incomingPatient) && currentPatients.length > 0) continue

      let state = mergeTasksAndUncertainties(
        [],
        cloneTasks(incomingTasksByPatient.get(incomingPatient.patientKey) ?? incomingPatient.tasks),
        [],
        incomingPatient.uncertainties,
      )
      let added = { ...clonePatient(incomingPatient), ...state }
      mergedIndexByKey.set(added.patientKey, mergedPatients.length)
      mergedPatients.push(added)
      incomingKeyRemap.set(incomingPatient.patientKey, added.patientKey)
      sourceByPatientKey.set(added.patientKey, {
        incomingKey: incomingPatient.patientKey,
      })
      continue
    }

    let index = mergedIndexByKey.get(currentPatient.patientKey)
    if (index == null) continue
    let currentMerged = mergedPatients[index]!
    let nextTasks = incomingTasksByPatient.get(incomingPatient.patientKey) ?? incomingPatient.tasks
    let merged = mergePatient(currentMerged, incomingPatient, currentMerged.tasks, nextTasks)
    mergedPatients[index] = merged
    incomingKeyRemap.set(incomingPatient.patientKey, merged.patientKey)
    sourceByPatientKey.set(merged.patientKey, {
      incomingKey: incomingPatient.patientKey,
    })
  }

  let mergedAnalysis = mergeAnalysis(
    existing.analysis,
    incoming.analysis,
    mergedPatients,
    incomingKeyRemap,
  )
  let patientProjections = mergePatientProjections(
    existing.patientProjections,
    incoming.patientProjections,
    mergedPatients,
    sourceByPatientKey,
  )
  let taskProjections = buildTaskProjections(mergedPatients, existing.taskProjections)

  return { analysis: mergedAnalysis, patientProjections, taskProjections }
}

/**
 * Overlays clinician-owned creation metadata on the first model result.
 *
 * Participant defaults submitted by the recording form are not clinician review:
 * they only become authoritative after the metadata action durably records an
 * explicit clinician edit. Patient identity fields remain authoritative because
 * they are explicitly supplied for a patient-scoped handover.
 */
export function preserveCreateReviewMetadata(
  incoming: HandoverAnalysisResult,
  initial: CreateReviewMetadata,
  current: CreateReviewMetadata,
): PreservedCreateReviewMetadata {
  let participantsOverride = current.participantsEdited ? [...current.participants] : null
  let displayName = current.linkedPatientDisplayName?.trim() || null
  let location = current.linkedPatientLocation?.trim() || null
  let targetPatientKey = displayName || location
    ? findCreateReviewPatientKey(incoming, initial, current)
    : null
  let patients = targetPatientKey
    ? incoming.analysis.patients.map((patient) => patient.patientKey === targetPatientKey
      ? {
          ...patient,
          ...(displayName ? { displayName } : {}),
          ...(location ? { location } : {}),
        }
      : patient)
    : incoming.analysis.patients
  let patientProjections = targetPatientKey
    ? incoming.patientProjections.map((patient) => patient.patientKey === targetPatientKey
      ? {
          ...patient,
          ...(displayName ? { displayName } : {}),
          ...(location ? { location } : {}),
        }
      : patient)
    : incoming.patientProjections
  let analysis = participantsOverride !== null || patients !== incoming.analysis.patients
    ? {
        ...incoming.analysis,
        ...(participantsOverride !== null ? { participants: [...participantsOverride] } : {}),
        patients,
      }
    : incoming.analysis
  let linkedPatientIsAuthoritative = Boolean(
    current.linkedPatientKey && (displayName || location),
  )

  return {
    result: analysis === incoming.analysis && patientProjections === incoming.patientProjections
      ? incoming
      : { ...incoming, analysis, patientProjections },
    titleOverride: linkedPatientIsAuthoritative || current.title !== initial.title
      ? current.title
      : null,
    participantsOverride,
  }
}

/** Preserves review-header edits made while a continuation analysis is running. */
export function preserveExtensionReviewMetadata(
  incoming: HandoverAnalysisResult,
  initial: CreateReviewMetadata,
  current: CreateReviewMetadata,
): PreservedCreateReviewMetadata {
  let participantsChanged = !sameStringList(initial.participants, current.participants)
  let participantsOverride = participantsChanged
    ? mergeConcurrentParticipantEdit(
        initial.participants,
        current.participants,
        incoming.analysis.participants,
      )
    : null
  let analysis = participantsOverride === null
    ? incoming.analysis
    : { ...incoming.analysis, participants: [...participantsOverride] }

  return {
    result: analysis === incoming.analysis ? incoming : { ...incoming, analysis },
    // A continuation enriches an existing handover; it never owns its title.
    // This also preserves patient-derived title changes made before worker claim.
    titleOverride: current.title,
    participantsOverride,
  }
}

function mergeConcurrentParticipantEdit(
  initial: readonly string[],
  current: readonly string[],
  incoming: readonly string[],
): string[] {
  let currentKeys = new Set(current.map(normalizeText))
  let removedKeys = new Set(
    initial.map(normalizeText).filter((key) => !currentKeys.has(key)),
  )
  return uniqueStrings([
    ...current,
    ...incoming.filter((participant) => !removedKeys.has(normalizeText(participant))),
  ])
}

function findCreateReviewPatientKey(
  incoming: HandoverAnalysisResult,
  initial: CreateReviewMetadata,
  current: CreateReviewMetadata,
): string | null {
  for (let key of [current.linkedPatientKey, initial.linkedPatientKey]) {
    if (key && incoming.analysis.patients.some((patient) => patient.patientKey === key)) return key
  }
  if (incoming.analysis.patients.length === 1) return incoming.analysis.patients[0]!.patientKey

  let initialName = initial.linkedPatientDisplayName
    ? normalizeText(initial.linkedPatientDisplayName)
    : ''
  let initialLocation = initial.linkedPatientLocation
    ? normalizeText(initial.linkedPatientLocation)
    : ''
  let matches = incoming.analysis.patients.filter((patient) =>
    Boolean(initialName && normalizeText(patient.displayName) === initialName)
    || Boolean(initialLocation && normalizeText(patient.location) === initialLocation),
  )
  return matches.length === 1 ? matches[0]!.patientKey : null
}

function sameStringList(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function mergeAnalysis(
  current: PersistedHandoverAnalysis,
  next: PersistedHandoverAnalysis,
  patients: PersistedPatientAnalysis[],
  incomingKeyRemap: ReadonlyMap<string, string>,
): PersistedHandoverAnalysis {
  let currentDraft = current.structuredSummaryMeta?.llmDraft ?? current.structuredSummary
  let nextDraft = next.structuredSummaryMeta?.llmDraft ?? next.structuredSummary
  let mergedDraft = mergeSummary(currentDraft, nextDraft)
  let currentWasReviewed = current.structuredSummaryMeta?.reviewed === true
  let mergedSummary = mergeClinicianSummary(current.structuredSummary, next.structuredSummary)
  let reviewed = currentWasReviewed && summariesEqual(currentDraft, mergedDraft)
  let patientKeys = new Set(patients.map((patient) => patient.patientKey))

  return {
    ...current,
    titleSuggestion: current.titleSuggestion,
    headline: mergeNarrative(current.headline, next.headline, {
      prefix: 'Update after recommenced handover: ',
    }),
    overview: mergeNarrative(current.overview, next.overview, {
      prefix: 'Update after recommenced handover: ',
    }),
    participants: uniqueStrings([...current.participants, ...next.participants]),
    structuredSummary: mergedSummary,
    structuredSummaryMeta: {
      llmDraft: mergedDraft,
      reviewed,
      edits: current.structuredSummaryMeta?.edits?.map((edit) => ({ ...edit })) ?? [],
    },
    sbarEvidence: uniqueBy(
      [...current.sbarEvidence, ...next.sbarEvidence],
      (span) => `${normalizeText(span.label)}::${normalizeText(span.quote)}`,
    ).map((span) => ({ ...span })),
    checklistFocus: mergeChecklist(current.checklistFocus, next.checklistFocus),
    transcriptHighlights: uniqueStrings([
      ...current.transcriptHighlights,
      ...next.transcriptHighlights,
    ]),
    patients,
    communicationRisks: uniqueBy(
      [
        ...current.communicationRisks.map((risk) => ({ ...risk })),
        ...next.communicationRisks.map((risk) => {
          let mappedPatientKey = risk.patientKey
            ? incomingKeyRemap.get(risk.patientKey) ?? risk.patientKey
            : null
          return {
            ...risk,
            patientKey: mappedPatientKey && patientKeys.has(mappedPatientKey)
              ? mappedPatientKey
              : null,
          }
        }),
      ],
      (risk) => `${risk.type}::${risk.patientKey ?? 'global'}::${normalizeText(risk.evidence)}`,
    ),
    openQuestions: uniqueStrings([...current.openQuestions, ...next.openQuestions]),
    feedback: {
      qualityScore: current.feedback.qualityScore,
      whatWorked: uniqueStrings([...current.feedback.whatWorked, ...next.feedback.whatWorked]),
      needsAttention: uniqueStrings([
        ...current.feedback.needsAttention,
        ...next.feedback.needsAttention,
      ]),
      repeatedInformation: uniqueStrings([
        ...current.feedback.repeatedInformation,
        ...next.feedback.repeatedInformation,
      ]),
      coachingTips: uniqueStrings([
        ...current.feedback.coachingTips,
        ...next.feedback.coachingTips,
      ]),
      durationComment: mergeNarrative(
        current.feedback.durationComment,
        next.feedback.durationComment,
        { prefix: 'Update after recommenced handover: ' },
      ),
    },
    interruptionAssessment: mergeInterruptionAssessment(
      current.interruptionAssessment,
      next.interruptionAssessment,
    ),
    analysisReadiness: mergeReadiness(current.analysisReadiness, next.analysisReadiness),
  }
}

function mergeClinicianSummary(
  current: AnalysisSummary,
  next: AnalysisSummary,
): AnalysisSummary {
  // Keep clinician text at the start of each visible section, but always surface
  // newly analysed evidence. The separately merged llmDraft remains the baseline
  // used by the UI to mark clinician-authored text.
  let mergeSection = (key: keyof AnalysisSummary) => mergeSbarSection(current[key], next[key])

  return {
    situation: mergeSection('situation'),
    background: mergeSection('background'),
    assessment: mergeSection('assessment'),
    recommendation: mergeSection('recommendation'),
  }
}

function mergeSummary(current: AnalysisSummary, next: AnalysisSummary): AnalysisSummary {
  return {
    situation: mergeSbarSection(current.situation, next.situation),
    background: mergeSbarSection(current.background, next.background),
    assessment: mergeSbarSection(current.assessment, next.assessment),
    recommendation: mergeSbarSection(current.recommendation, next.recommendation),
  }
}

function mergePatient(
  current: PersistedPatientAnalysis,
  next: PersistedPatientAnalysis,
  currentTasks: PersistedTask[],
  nextTasks: PersistedTask[],
): PersistedPatientAnalysis {
  let currentIsPlaceholder = isPlaceholderPatient(current)
  let nextIsSpecific = !isPlaceholderPatient(next)
  let identity = {
    displayName: currentIsPlaceholder && nextIsSpecific ? next.displayName : current.displayName,
    location: isPlaceholderLocation(current.location) && !isPlaceholderLocation(next.location)
      ? next.location
      : current.location,
  }
  let { tasks, uncertainties } = mergeTasksAndUncertainties(
    currentTasks,
    nextTasks,
    current.uncertainties,
    next.uncertainties,
  )

  return {
    ...clonePatient(current),
    patientKey: current.patientKey,
    ...identity,
    priorityScores: {
      acuity: Math.max(current.priorityScores.acuity, next.priorityScores.acuity),
      risk: Math.max(current.priorityScores.risk, next.priorityScores.risk),
      workflow: Math.max(current.priorityScores.workflow, next.priorityScores.workflow),
    },
    priorityReason: mergeNarrative(current.priorityReason, next.priorityReason),
    summary: {
      situation: currentIsPlaceholder || !isPlaceholderPatient(next)
        ? mergeSbarSection(current.summary.situation, next.summary.situation)
        : current.summary.situation,
      background: mergeSbarSection(current.summary.background, next.summary.background),
      assessment: mergeSbarSection(current.summary.assessment, next.summary.assessment),
      recommendation: mergeSbarSection(
        current.summary.recommendation,
        next.summary.recommendation,
      ),
    },
    keyRisks: uniqueStrings([...current.keyRisks, ...next.keyRisks]),
    checklist: mergeChecklist(current.checklist, next.checklist),
    tasks,
    uncertainties,
    queryBookmarks: [],
    lastConfirmedPoint: mergeNarrative(current.lastConfirmedPoint, next.lastConfirmedPoint),
    restartPrompt: mergeNarrative(current.restartPrompt, next.restartPrompt),
  }
}

function mergeTasksAndUncertainties(
  currentTasks: PersistedTask[],
  nextTasks: PersistedTask[],
  currentUncertainties: PersistedUncertainty[],
  nextUncertainties: PersistedUncertainty[],
): { tasks: PersistedTask[]; uncertainties: PersistedUncertainty[] } {
  let currentUncertaintyByStatement = new Map(
    currentUncertainties.map((uncertainty) => [normalizeText(uncertainty.statement), uncertainty]),
  )
  let uncertaintyIdRemap = new Map<string, string>()
  for (let uncertainty of nextUncertainties) {
    let match = currentUncertaintyByStatement.get(normalizeText(uncertainty.statement))
    uncertaintyIdRemap.set(uncertainty.id, match?.id ?? uncertainty.id)
  }

  let tasks = cloneTasks(currentTasks)
  let taskById = new Map(tasks.map((task) => [task.id, task]))
  let taskByTitle = new Map(tasks.map((task) => [normalizeText(task.title), task]))
  let taskByRelatedUncertainty = new Map(
    tasks.flatMap((task) => task.relatedUncertaintyId
      ? [[task.relatedUncertaintyId, task] as const]
      : []),
  )
  let taskIdRemap = new Map<string, string>()

  for (let nextTask of nextTasks) {
    let relatedUncertaintyId = nextTask.relatedUncertaintyId
      ? uncertaintyIdRemap.get(nextTask.relatedUncertaintyId) ?? nextTask.relatedUncertaintyId
      : null
    let match = taskById.get(nextTask.id)
      ?? (relatedUncertaintyId ? taskByRelatedUncertainty.get(relatedUncertaintyId) : undefined)
      ?? taskByTitle.get(normalizeText(nextTask.title))
    if (match) {
      taskIdRemap.set(nextTask.id, match.id)
      if (!match.relatedUncertaintyId && match.source !== 'manual' && relatedUncertaintyId) {
        match.relatedUncertaintyId = relatedUncertaintyId
      }
      if (match.relatedUncertaintyId) {
        taskByRelatedUncertainty.set(match.relatedUncertaintyId, match)
      }
      continue
    }

    let added = { ...nextTask, relatedUncertaintyId }
    tasks.push(added)
    taskById.set(added.id, added)
    taskByTitle.set(normalizeText(added.title), added)
    if (added.relatedUncertaintyId) {
      taskByRelatedUncertainty.set(added.relatedUncertaintyId, added)
    }
    taskIdRemap.set(nextTask.id, added.id)
  }

  let uncertainties = currentUncertainties.map((uncertainty) => ({ ...uncertainty }))
  let uncertaintyIndexByStatement = new Map(
    uncertainties.map((uncertainty, index) => [normalizeText(uncertainty.statement), index]),
  )
  for (let nextUncertainty of nextUncertainties) {
    let key = normalizeText(nextUncertainty.statement)
    let index = uncertaintyIndexByStatement.get(key)
    let linkedTaskId = nextUncertainty.linkedTaskId
      ? taskIdRemap.get(nextUncertainty.linkedTaskId) ?? nextUncertainty.linkedTaskId
      : null
    if (index == null) {
      let added = { ...nextUncertainty, linkedTaskId }
      uncertaintyIndexByStatement.set(key, uncertainties.length)
      uncertainties.push(added)
      continue
    }

    let current = uncertainties[index]!
    uncertainties[index] = {
      ...current,
      verificationNeed: mergeNarrative(current.verificationNeed, nextUncertainty.verificationNeed),
      linkedTaskId: current.linkedTaskId ?? linkedTaskId,
      clinicianDecisionNote: current.clinicianDecisionNote,
      confidence: current.confidence,
    }
  }

  let uncertaintyIds = new Set(uncertainties.map((uncertainty) => uncertainty.id))
  let taskIds = new Set(tasks.map((task) => task.id))
  tasks = tasks.map((task) => ({
    ...task,
    relatedUncertaintyId: task.relatedUncertaintyId && uncertaintyIds.has(task.relatedUncertaintyId)
      ? task.relatedUncertaintyId
      : null,
  }))
  uncertainties = uncertainties.map((uncertainty) => ({
    ...uncertainty,
    linkedTaskId: uncertainty.linkedTaskId && taskIds.has(uncertainty.linkedTaskId)
      ? uncertainty.linkedTaskId
      : null,
  }))

  return { tasks, uncertainties }
}

function mergeChecklist(
  currentItems: PersistedChecklistItem[],
  nextItems: PersistedChecklistItem[],
): PersistedChecklistItem[] {
  let merged = currentItems.map((item) => ({ ...item }))
  let indexByLabel = new Map(
    merged.map((item, index) => [normalizeText(item.label), index]),
  )

  for (let next of nextItems) {
    let index = indexByLabel.get(normalizeText(next.label))
    if (index == null) {
      indexByLabel.set(normalizeText(next.label), merged.length)
      merged.push({ ...next })
      continue
    }

    let current = merged[index]!
    if (checklistStatusRank[next.status] < checklistStatusRank[current.status]) continue
    merged[index] = {
      ...current,
      status: next.status,
      note: mergeNarrative(current.note, next.note),
    }
  }

  return merged
}

function mergePatientProjections(
  current: PatientProjection[],
  next: PatientProjection[],
  patients: PersistedPatientAnalysis[],
  sourceByPatientKey: ReadonlyMap<string, PatientMergeSource>,
): PatientProjection[] {
  let currentByKey = new Map(current.map((projection) => [projection.patientKey, projection]))
  let nextByKey = new Map(next.map((projection) => [projection.patientKey, projection]))
  let usedIds = new Set<string>()
  let projections = patients.map((patient) => {
    let source = sourceByPatientKey.get(patient.patientKey)
    let currentProjection = currentByKey.get(patient.patientKey)
    let nextProjection = source?.incomingKey ? nextByKey.get(source.incomingKey) : undefined
    let base = currentProjection ?? nextProjection
    let projection: PatientProjection = {
      id: base?.id ?? `patient-${patient.patientKey}`,
      patientKey: patient.patientKey,
      displayName: patient.displayName,
      location: patient.location,
      acuityScore: patient.priorityScores.acuity,
      riskScore: patient.priorityScores.risk,
      workflowScore: patient.priorityScores.workflow,
      priorityReason: patient.priorityReason,
    }
    usedIds.add(projection.id)
    return projection
  })

  for (let projection of current) {
    if (usedIds.has(projection.id)) continue
    projections.push({ ...projection })
    usedIds.add(projection.id)
  }
  return projections
}

function buildTaskProjections(
  patients: PersistedPatientAnalysis[],
  existing: TaskProjection[],
): TaskProjection[] {
  let projections = patients.flatMap((patient) => patient.tasks.map((task) => ({
    patientKey: patient.patientKey,
    ...task,
  })))
  let ids = new Set(projections.map((task) => task.id))

  for (let task of existing) {
    if (ids.has(task.id)) continue
    projections.push({ ...task })
    ids.add(task.id)
  }
  return projections
}

function mergeInterruptionAssessment(
  current: PersistedHandoverAnalysis['interruptionAssessment'],
  next: PersistedHandoverAnalysis['interruptionAssessment'],
): PersistedHandoverAnalysis['interruptionAssessment'] {
  return {
    status: interruptionStatusRank[next.status] > interruptionStatusRank[current.status]
      ? next.status
      : current.status,
    summary: mergeNarrative(current.summary, next.summary),
    evidence: uniqueStrings([...current.evidence, ...next.evidence]),
    recommendation: mergeNarrative(current.recommendation, next.recommendation),
  }
}

function mergeReadiness(
  current: PersistedHandoverAnalysis['analysisReadiness'],
  next: PersistedHandoverAnalysis['analysisReadiness'],
): PersistedHandoverAnalysis['analysisReadiness'] {
  return {
    overview: current.overview || next.overview,
    patients: current.patients || next.patients,
    actions: current.actions || next.actions,
    communication: current.communication || next.communication,
    checklist: current.checklist || next.checklist,
    recommence: current.recommence || next.recommence,
    riskSignals: current.riskSignals || next.riskSignals,
    sbarEvidence: current.sbarEvidence || next.sbarEvidence,
    summary: current.summary || next.summary,
    uncertainty: current.uncertainty || next.uncertainty,
  }
}

function findPatientMatch(
  currentPatients: PersistedPatientAnalysis[],
  lookup: ReadonlyMap<string, PersistedPatientAnalysis>,
  incoming: PersistedPatientAnalysis,
): PersistedPatientAnalysis | null {
  for (let key of patientLookupKeys(incoming)) {
    let match = lookup.get(key)
    if (match) return match
  }

  let knownCurrent = currentPatients.filter((patient) => !isPlaceholderPatient(patient))
  if (isPlaceholderPatient(incoming)) {
    if (knownCurrent.length === 1) return knownCurrent[0]!
    if (currentPatients.length === 1) return currentPatients[0]!
    return null
  }

  if (currentPatients.length === 1 && isPlaceholderPatient(currentPatients[0]!)) {
    return currentPatients[0]!
  }

  return null
}

function buildPatientLookup(patients: PersistedPatientAnalysis[]) {
  let lookup = new Map<string, PersistedPatientAnalysis>()
  for (let patient of patients) {
    for (let key of patientLookupKeys(patient)) lookup.set(key, patient)
  }
  return lookup
}

function patientLookupKeys(patient: Pick<PersistedPatientAnalysis, 'patientKey' | 'displayName' | 'location'>) {
  return uniqueStrings([
    normalizePatientKey(patient.patientKey),
    normalizePatientKey(`${patient.displayName}-${patient.location}`),
    normalizePatientKey(patient.displayName),
  ].filter(Boolean))
}

function isPlaceholderPatient(
  patient: Pick<PersistedPatientAnalysis, 'patientKey' | 'displayName'>,
): boolean {
  let key = normalizePatientKey(patient.patientKey)
  let name = normalizePatientKey(patient.displayName)
  return /^patient-\d+$/.test(key) || [
    '',
    'patient',
    'unknown',
    'unknown-patient',
    'unnamed-patient',
    'unnamed-female',
    'unnamed-male',
  ].includes(key) || [
    '',
    'patient',
    'unknown',
    'unknown-patient',
    'unnamed-patient',
    'unnamed-female',
    'unnamed-male',
  ].includes(name)
}

function isPlaceholderLocation(value: string) {
  let normalized = normalizeText(value)
  return !normalized || normalized === 'location not stated' || normalized === 'unknown'
}

function mergeSbarSection(current: string, next: string): string {
  return mergeNarrative(current, next, { stripSbarPlaceholder: true }) ||
    (isSbarPlaceholder(current) || isSbarPlaceholder(next)
      ? 'Not mentioned in supplied evidence.'
      : '')
}

function mergeNarrative(
  current: string,
  next: string,
  options: { prefix?: string; stripSbarPlaceholder?: boolean } = {},
) {
  let currentValue = current.trim()
  let nextValue = next.trim()
  if (options.stripSbarPlaceholder && isSbarPlaceholder(currentValue)) currentValue = ''
  if (options.stripSbarPlaceholder && isSbarPlaceholder(nextValue)) nextValue = ''
  if (!currentValue) return nextValue
  if (!nextValue) return currentValue

  let currentKey = normalizeText(currentValue)
  let nextKey = normalizeText(nextValue)
  if (currentKey === nextKey || currentKey.includes(nextKey)) return currentValue
  if (nextKey.includes(currentKey)) return nextValue
  return `${currentValue}\n\n${options.prefix ?? ''}${nextValue}`
}

function isSbarPlaceholder(value: string) {
  return SBAR_PLACEHOLDERS.has(normalizeText(value))
}

function summariesEqual(left: AnalysisSummary, right: AnalysisSummary) {
  return (Object.keys(left) as Array<keyof AnalysisSummary>)
    .every((key) => normalizeText(left[key]) === normalizeText(right[key]))
}

function groupTasks(tasks: TaskProjection[]) {
  let grouped = new Map<string, PersistedTask[]>()
  for (let task of tasks) {
    let patientTasks = grouped.get(task.patientKey) ?? []
    patientTasks.push(toPersistedTask(task))
    grouped.set(task.patientKey, patientTasks)
  }
  return grouped
}

function toPersistedTask(task: TaskProjection): PersistedTask {
  return {
    id: task.id,
    title: task.title,
    dueLabel: task.dueLabel,
    dueAt: task.dueAt,
    priority: task.priority,
    status: task.status,
    reminderEnabled: task.reminderEnabled,
    carriedForward: task.carriedForward,
    source: task.source,
    relatedUncertaintyId: task.relatedUncertaintyId,
  }
}

function cloneTasks(tasks: readonly PersistedTask[]) {
  return tasks.map((task) => ({ ...task }))
}

function clonePatient(patient: PersistedPatientAnalysis): PersistedPatientAnalysis {
  return {
    ...patient,
    priorityScores: { ...patient.priorityScores },
    summary: { ...patient.summary },
    keyRisks: [...patient.keyRisks],
    checklist: patient.checklist.map((item) => ({ ...item })),
    tasks: cloneTasks(patient.tasks),
    uncertainties: patient.uncertainties.map((uncertainty) => ({ ...uncertainty })),
    queryBookmarks: [],
  }
}

function normalizeText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizePatientKey(value: string) {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function uniqueStrings(values: string[]) {
  return uniqueBy(values.filter((value) => value.trim()), normalizeText)
}

function uniqueBy<T>(values: T[], key: (value: T) => string) {
  let seen = new Set<string>()
  return values.filter((value) => {
    let valueKey = key(value)
    if (seen.has(valueKey)) return false
    seen.add(valueKey)
    return true
  })
}
