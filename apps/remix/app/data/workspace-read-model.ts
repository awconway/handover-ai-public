import type {
  HandoverPatientRow,
  HandoverRow,
  HandoverTaskRow,
  ShiftRow,
  ShiftSheetPatientRow,
} from './schema.ts'
import {
  derivedPatientIdentityKey,
  isPlaceholderPatientKey,
  meaningfulPatientIdentity,
  normalizePatientKey,
  patientIdentityKey,
} from './patient-identity.ts'

export type WorkspaceDirection = 'incoming' | 'intra-shift' | 'outgoing'

export type WorkspaceHandoverReadModel = {
  row: HandoverRow
  direction: WorkspaceDirection
  patientCount: number
  subtitle: string
}

export type WorkspacePatientReadModel = {
  key: string
  sheetPatient: ShiftSheetPatientRow | null
  clinicalRows: HandoverPatientRow[]
  handovers: WorkspaceHandoverReadModel[]
  processingHandovers: WorkspaceHandoverReadModel[]
  taskIds: string[]
  priorityScore: number
  openTaskCount: number
}

export type ShiftWorkspaceReadModel = {
  shift: ShiftRow
  handovers: WorkspaceHandoverReadModel[]
  availableHandovers: WorkspaceHandoverReadModel[]
  patients: WorkspacePatientReadModel[]
  handoverCount: number
  patientCount: number
  openTaskCount: number
}

export function resolveWorkspacePatientReadModel(
  patients: readonly WorkspacePatientReadModel[],
  workspaceKey: string,
) {
  let targetKey = normalizePatientKey(workspaceKey)
  if (!targetKey) return null
  let exact = patients.filter((patient) => normalizePatientKey(patient.key) === targetKey)
  if (exact.length === 1) return exact[0]!
  if (exact.length > 1) return null

  let aliases = patients.filter((patient) => {
    let references = [
      ...(patient.sheetPatient ? [{
        key: patient.sheetPatient.patient_key,
        displayName: patient.sheetPatient.display_name,
        location: patient.sheetPatient.location,
      }] : []),
      ...patient.clinicalRows.map((row) => ({
        key: row.patient_key,
        displayName: row.display_name,
        location: row.location,
      })),
      ...patient.processingHandovers.flatMap((handover) =>
        handover.row.linked_patient_key ? [{
          key: handover.row.linked_patient_key,
          displayName: handover.row.linked_patient_display_name,
          location: handover.row.linked_patient_location,
        }] : [],
      ),
    ]
    return references.some((reference) =>
      normalizePatientKey(reference.key) === targetKey
      || normalizePatientKey(patientIdentityKey(reference) ?? '') === targetKey,
    )
  })
  return aliases.length === 1 ? aliases[0]! : null
}

type WorkspacePatientAccumulator = {
  key: string
  sheetPatient: ShiftSheetPatientRow | null
  clinicalRows: HandoverPatientRow[]
  handovers: WorkspaceHandoverReadModel[]
  processingHandovers: WorkspaceHandoverReadModel[]
  taskIds: string[]
}

export function isHandoverRelatedToShift(
  handover: Pick<HandoverRow, 'shift_id' | 'source_shift_id' | 'source_handover_id'>,
  shiftId: string,
) {
  return handover.shift_id === shiftId || (!handover.source_handover_id && handover.source_shift_id === shiftId)
}

function isProcessingActive(status: HandoverRow['processing_status']) {
  return status === 'queued' || status === 'transcribing' || status === 'analysing'
}

function isAvailableShiftHandover(
  handover: Pick<HandoverRow, 'id' | 'processing_status'>,
  persistedPatientHandoverIds: ReadonlySet<string>,
) {
  return handover.processing_status === 'completed' || persistedPatientHandoverIds.has(handover.id)
}

function isVisibleShiftHandover(
  handover: Pick<HandoverRow, 'id' | 'processing_status'>,
  persistedPatientHandoverIds: ReadonlySet<string>,
) {
  return handover.processing_status !== 'failed' || isAvailableShiftHandover(handover, persistedPatientHandoverIds)
}

export function resolveShiftScopedHandoverDirection(
  handover: Pick<HandoverRow, 'direction' | 'title' | 'notes' | 'shift_id' | 'source_shift_id'>,
  shiftId: string,
): WorkspaceDirection {
  if (handover.direction === 'outgoing') {
    if (handover.source_shift_id && handover.source_shift_id !== handover.shift_id) {
      if (handover.source_shift_id === shiftId) return 'outgoing'
      if (handover.shift_id === shiftId) return 'incoming'
    }
    return 'outgoing'
  }
  return inferHandoverDirection(handover)
}

export function handoverSubtitle(
  handover: Pick<HandoverRow, 'analysis' | 'notes' | 'processing_status'>,
) {
  let analysis = record(handover.analysis)
  let readiness = record(analysis?.analysisReadiness)
  let patients = readiness?.patients === false ? [] : records(analysis?.patients)
  let previews = patients.flatMap((patient) => {
    let displayName = text(patient.displayName)
    if (!displayName) return []
    let location = text(patient.location)
    return [location ? `${displayName} · ${location}` : displayName]
  })
  let patientPreview = previews.length <= 2
    ? previews.join(', ')
    : `${previews.slice(0, 2).join(', ')} +${previews.length - 2} more`
  let preview = patientPreview || handover.notes.trim() || text(analysis?.overview)
  if (preview) return preview

  switch (handover.processing_status) {
    case 'failed': return 'Open the handover to retry or inspect details.'
    case 'queued': return 'Queued for transcription and analysis. This will continue automatically.'
    case 'transcribing': return 'Transcribing the handover so analysis can begin.'
    case 'analysing': return 'Extracting the summary, checking risks, and finalising review sections.'
    case 'completed': return 'Ready for review'
  }
}

export function analysisPatientCount(analysisValue: unknown) {
  return records(record(analysisValue)?.patients).filter((patient) => Boolean(patientIdentityKey({
    key: text(patient.patientKey),
    displayName: text(patient.displayName),
    location: text(patient.location),
  }))).length
}

export function buildShiftWorkspaceReadModel(input: {
  shift: ShiftRow
  handovers: HandoverRow[]
  sheetPatients: ShiftSheetPatientRow[]
  handoverPatients: HandoverPatientRow[]
  tasks: HandoverTaskRow[]
}): ShiftWorkspaceReadModel {
  let { shift } = input
  let relatedRows = input.handovers.filter((handover) => isHandoverRelatedToShift(handover, shift.id))
  let relatedIds = new Set(relatedRows.map((handover) => handover.id))
  let relatedClinicalRows = input.handoverPatients.filter((patient) => relatedIds.has(patient.handover_id))
  let persistedIds = new Set(relatedClinicalRows.map((patient) => patient.handover_id))
  let visibleRows = relatedRows.filter((handover) => isVisibleShiftHandover(handover, persistedIds))
  let availableRows = visibleRows.filter((handover) => isAvailableShiftHandover(handover, persistedIds))
  let availableIds = new Set(availableRows.map((handover) => handover.id))
  let visibleIds = new Set(visibleRows.map((handover) => handover.id))
  let availableClinicalRows = relatedClinicalRows.filter((patient) => availableIds.has(patient.handover_id))
  let handoverModel = (row: HandoverRow): WorkspaceHandoverReadModel => ({
    row,
    direction: resolveShiftScopedHandoverDirection(row, shift.id),
    patientCount: patientCountForHandover(row, availableClinicalRows, input.sheetPatients),
    subtitle: handoverSubtitle(row),
  })
  let visibleHandovers = visibleRows.map(handoverModel)
  let visibleMap = new Map(visibleHandovers.map((handover) => [handover.row.id, handover]))
  let availableHandovers = availableRows.map((row) => visibleMap.get(row.id)!)
  let patientMap = new Map<string, WorkspacePatientAccumulator>()

  for (let patient of input.sheetPatients.toSorted((left, right) => left.row_index - right.row_index)) {
    patientMap.set(patient.patient_key, emptyPatient(patient.patient_key, patient))
  }
  for (let clinical of availableClinicalRows.toSorted((left, right) => time(right.created_at) - time(left.created_at))) {
    let reference = {
      key: clinical.patient_key,
      displayName: clinical.display_name,
      location: clinical.location,
    }
    let patient = findCanonicalPatient(patientMap, reference)
    if (!patient) {
      let fallbackKey = isPlaceholderPatientKey(clinical.patient_key)
        ? patientIdentityKey(reference)
        : clinical.patient_key
      if (!fallbackKey) continue
      patient = patientMap.get(fallbackKey) ?? emptyPatient(fallbackKey, null)
    }
    if (!patientMap.has(patient.key)) patientMap.set(patient.key, patient)
    patient.clinicalRows.push(clinical)
    let handover = visibleMap.get(clinical.handover_id)
    if (handover && !patient.handovers.some((candidate) => candidate.row.id === handover.row.id)) patient.handovers.push(handover)
  }
  for (let handover of visibleHandovers) {
    let linkedKey = handover.row.linked_patient_key?.trim()
    if (!linkedKey || !isProcessingActive(handover.row.processing_status) || persistedIds.has(handover.row.id)) continue
    let reference = {
      key: linkedKey,
      displayName: handover.row.linked_patient_display_name,
      location: handover.row.linked_patient_location,
    }
    let patient = findCanonicalPatient(patientMap, reference)
    if (!patient) {
      let fallbackKey = patientIdentityKey(reference)
      if (!fallbackKey) continue
      patient = patientMap.get(fallbackKey) ?? emptyPatient(fallbackKey, null)
      patientMap.set(patient.key, patient)
    }
    if (!patient.processingHandovers.some((candidate) => candidate.row.id === handover.row.id)) patient.processingHandovers.push(handover)
  }

  let order = new Map(shift.patient_order.map((key, index) => [normalizePatientKey(key), index]))
  let availableTasks = input.tasks.filter((task) => availableIds.has(task.handover_id))
  let analysisTaskPatients = findAnalysisTaskPatients(availableRows, patientMap)
  for (let task of availableTasks) {
    let patient = isPlaceholderPatientKey(task.patient_key)
      ? analysisTaskPatients.get(handoverTaskReference(task.handover_id, task.id))
        ?? findOnlyHandoverPatient(patientMap, task.handover_id)
      : findCanonicalPatient(patientMap, { key: task.patient_key })
    if (patient && !patient.taskIds.includes(task.id)) patient.taskIds.push(task.id)
  }
  let patients: WorkspacePatientReadModel[] = [...patientMap.values()].map((patient) => {
    patient.handovers.sort(compareHandovers)
    patient.processingHandovers.sort((left, right) => time(right.row.updated_at) - time(left.row.updated_at))
    let latestClinical = patient.clinicalRows[0]
    let taskIds = new Set(patient.taskIds)
    return {
      ...patient,
      priorityScore: latestClinical
        ? Number(latestClinical.acuity_score) + Number(latestClinical.risk_score) + Number(latestClinical.workflow_score)
        : 0,
      openTaskCount: availableTasks.filter((task) => taskIds.has(task.id) && task.status !== 'done').length,
    }
  }).sort((left, right) => {
    let leftIndex = order.get(normalizePatientKey(left.key))
    let rightIndex = order.get(normalizePatientKey(right.key))
    if (leftIndex != null && rightIndex != null) return leftIndex - rightIndex
    if (leftIndex != null) return -1
    if (rightIndex != null) return 1
    return patientUpdatedAt(right) - patientUpdatedAt(left)
  })

  return {
    shift,
    handovers: visibleHandovers,
    availableHandovers,
    patients,
    handoverCount: availableHandovers.length,
    patientCount: patients.length,
    openTaskCount: input.tasks.filter((task) => visibleIds.has(task.handover_id) && availableIds.has(task.handover_id) && task.status !== 'done').length,
  }
}

function inferHandoverDirection(handover: Pick<HandoverRow, 'direction' | 'title' | 'notes'>): WorkspaceDirection {
  if (handover.direction) return handover.direction
  let title = handover.title.trim().toLowerCase()
  let notes = handover.notes.trim().toLowerCase()
  if (title.startsWith('intra-shift handover') || title.startsWith('another handover') || notes.startsWith('intra-shift handover for') || notes.startsWith('another handover for')) return 'intra-shift'
  if (title.startsWith('outgoing handover') || title.startsWith('delivering handover') || notes.startsWith('outgoing handover for') || notes.startsWith('delivering handover for')) return 'outgoing'
  return 'incoming'
}

function patientCountForHandover(
  handover: HandoverRow,
  clinicalRows: HandoverPatientRow[],
  sheetPatients: ShiftSheetPatientRow[],
) {
  let keys = new Set(clinicalRows.filter((patient) => patient.handover_id === handover.id).map((patient) => {
    let sheetPatient = isPlaceholderPatientKey(patient.patient_key)
      ? findCanonicalSheetPatient(sheetPatients, {
          displayName: patient.display_name,
          location: patient.location,
        })
      : null
    return patientIdentityKey({
      key: sheetPatient?.patient_key ?? patient.patient_key,
      displayName: patient.display_name,
      location: patient.location,
    })
  }))
  if (handover.linked_patient_key) {
    let sheetPatient = isPlaceholderPatientKey(handover.linked_patient_key)
      ? findCanonicalSheetPatient(sheetPatients, {
          displayName: handover.linked_patient_display_name,
          location: handover.linked_patient_location,
        })
      : null
    keys.add(patientIdentityKey({
      key: sheetPatient?.patient_key ?? handover.linked_patient_key,
      displayName: handover.linked_patient_display_name,
      location: handover.linked_patient_location,
    }))
  }
  let persistedCount = [...keys].filter((key): key is string => Boolean(key)).length
  return Math.max(persistedCount, analysisPatientCount(handover.analysis))
}

function emptyPatient(key: string, sheetPatient: ShiftSheetPatientRow | null): WorkspacePatientAccumulator {
  return { key, sheetPatient, clinicalRows: [], handovers: [], processingHandovers: [], taskIds: [] }
}

function findAnalysisTaskPatients(
  handovers: HandoverRow[],
  patients: ReadonlyMap<string, WorkspacePatientAccumulator>,
) {
  let taskPatients = new Map<string, WorkspacePatientAccumulator>()
  let ambiguousTaskReferences = new Set<string>()
  for (let handover of handovers) {
    for (let analysisPatient of records(record(handover.analysis)?.patients)) {
      let patient = findCanonicalPatient(patients, {
        key: text(analysisPatient.patientKey),
        displayName: text(analysisPatient.displayName),
        location: text(analysisPatient.location),
      })
      if (!patient) continue
      for (let analysisTask of records(analysisPatient.tasks)) {
        let taskId = text(analysisTask.id)
        if (!taskId) continue
        let reference = handoverTaskReference(handover.id, taskId)
        let existing = taskPatients.get(reference)
        if (existing && existing !== patient) {
          taskPatients.delete(reference)
          ambiguousTaskReferences.add(reference)
        } else if (!ambiguousTaskReferences.has(reference)) {
          taskPatients.set(reference, patient)
        }
      }
    }
  }
  return taskPatients
}

function handoverTaskReference(handoverId: string, taskId: string) {
  return `${handoverId}\u0000${taskId}`
}

function findOnlyHandoverPatient(
  patients: ReadonlyMap<string, WorkspacePatientAccumulator>,
  handoverId: string,
) {
  let matches = [...patients.values()].filter((patient) =>
    patient.handovers.some((handover) => handover.row.id === handoverId),
  )
  return matches.length === 1 ? matches[0]! : null
}

function findCanonicalPatient(
  patients: ReadonlyMap<string, WorkspacePatientAccumulator>,
  reference: { key: string; displayName?: string | null; location?: string | null },
) {
  if (!isPlaceholderPatientKey(reference.key)) {
    if (patients.has(reference.key)) return patients.get(reference.key) ?? null
    let canonical = normalizePatientKey(reference.key)
    let keyMatches = [...patients.values()].filter((patient) => normalizePatientKey(patient.key) === canonical)
    if (keyMatches.length === 1) return keyMatches[0]!
  }
  let identityKey = derivedPatientIdentityKey(reference)
  if (!identityKey) return null
  if (patients.has(identityKey)) return patients.get(identityKey) ?? null
  let displayName = meaningfulPatientIdentity(reference.displayName)
  let location = meaningfulPatientIdentity(reference.location)
  let identityMatches = [...patients.values()].filter((patient) => {
    let candidateName = meaningfulPatientIdentity(
      patient.sheetPatient?.display_name ?? patient.clinicalRows[0]?.display_name,
    )
    let candidateLocation = meaningfulPatientIdentity(
      patient.sheetPatient?.location ?? patient.clinicalRows[0]?.location,
    )
    return candidateName === displayName && candidateLocation === location
  })
  if (identityMatches.length === 1) return identityMatches[0]!

  let sheetPatient = findCanonicalSheetPatient(
    [...patients.values()].flatMap((patient) => patient.sheetPatient ? [patient.sheetPatient] : []),
    reference,
  )
  return sheetPatient ? patients.get(sheetPatient.patient_key) ?? null : null
}

function findCanonicalSheetPatient(
  patients: ShiftSheetPatientRow[],
  reference: { displayName?: string | null; location?: string | null },
) {
  let displayName = meaningfulPatientIdentity(reference.displayName)
  let location = meaningfulPatientIdentity(reference.location)
  if (!displayName && !location) return null
  let matches = patients.filter((patient) => {
    let candidateName = meaningfulPatientIdentity(patient.display_name)
    let candidateLocation = meaningfulPatientIdentity(patient.location)
    if (displayName) {
      return candidateName === displayName && candidateLocation === location
    }
    return Boolean(location && candidateLocation === location)
  })
  return matches.length === 1 ? matches[0]! : null
}

function compareHandovers(left: WorkspaceHandoverReadModel, right: WorkspaceHandoverReadModel) {
  let directionOrder: Record<WorkspaceDirection, number> = { incoming: 0, 'intra-shift': 1, outgoing: 2 }
  return directionOrder[left.direction] - directionOrder[right.direction] || time(right.row.updated_at) - time(left.row.updated_at)
}

function patientUpdatedAt(patient: { sheetPatient: ShiftSheetPatientRow | null; handovers: WorkspaceHandoverReadModel[]; processingHandovers: WorkspaceHandoverReadModel[] }) {
  return Math.max(
    time(patient.handovers[0]?.row.updated_at),
    time(patient.processingHandovers[0]?.row.updated_at),
    time(patient.sheetPatient?.updated_at),
  )
}

function time(value: Date | string | number | null | undefined) {
  if (value instanceof Date) return value.getTime()
  let parsed = value == null ? 0 : new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try { return record(JSON.parse(value)) } catch { return null }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  let result: Array<Record<string, unknown>> = []
  for (let item of value) {
    let decoded = record(item)
    if (decoded) result.push(decoded)
  }
  return result
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}
