import { sql, type Database } from 'remix/data-table'

import type { HandoverSheetPatientField } from './handover-sheet.ts'
import { handoverSheetLabels, normalizeStoredHandoverSheetFields } from './handover-sheet.ts'
import {
  derivedPatientIdentityKey,
  isPlaceholderPatientKey,
  normalizePatientKey,
  resolvePatientIdentityReferences,
  safePlaceholderPatientAliasKeys,
} from './patient-identity.ts'
import { getShiftForUser } from './repository.ts'

type RelatedHandover = {
  id: string
  title: string
  direction: 'incoming' | 'intra-shift' | 'outgoing' | null
  linked_patient_key: string | null
  linked_patient_display_name: string | null
  linked_patient_location: string | null
  analysis: unknown
}

type SheetPatient = {
  id: string
  display_name: string
  location: string
  fields: unknown
}

type ClinicalPatientIdentity = {
  id: string
  handover_id: string
  patient_key: string
  display_name: string
  location: string
}

type HandoverTaskIdentity = {
  id: string
  handover_id: string
  patient_key: string
  related_uncertainty_id: string | null
}

export type ShiftPatientDetailsUpdate = {
  patientKey: string
  displayName: string
  location: string
  sheetUpdated: boolean
  handoverIds: string[]
}

/**
 * Updates the canonical representations that can contribute a patient card.
 *
 * The shift, optional handover, and patient relationship are authorised before
 * any write. A sheet-only patient updates its reviewed Name/Bed fields; a
 * handover-backed patient also updates every related clinical row, linked
 * metadata field, and analysis patient projection in the same shift.
 */
export async function updateShiftPatientDetails(db: Database, input: {
  shiftId: string
  patientKey: string
  handoverId?: string | null
  displayName: string
  location: string
  userId: string
}): Promise<ShiftPatientDetailsUpdate | null> {
  let shift = await getShiftForUser(db, input.shiftId, input.userId)
  if (!shift) return null

  let displayName = input.displayName.trim().slice(0, 240)
  let location = input.location.trim().slice(0, 120)
  if (!displayName || !location) return null

  return db.transaction(async (tx) => {
    let sheetResult = await tx.exec(sql`
      select id, display_name, location, fields
      from shift_sheet_patients
      where shift_id=${input.shiftId} and patient_key=${input.patientKey}
      for update
    `)
    let sheetPatient = sheetResult.rows?.[0] as SheetPatient | undefined

    let handoverResult = await tx.exec(sql`
      select h.id, h.title, h.direction, h.linked_patient_key,
        h.linked_patient_display_name, h.linked_patient_location, h.analysis
      from handovers h
      join shifts s on s.id = h.shift_id
      where h.shift_id=${input.shiftId}
        and (
          h.created_by_user_id=${input.userId}
          or jsonb_exists(h.shared_with_user_ids, ${input.userId})
          or s.created_by_user_id=${input.userId}
          or jsonb_exists(s.assigned_user_ids, ${input.userId})
          or exists (
            select 1 from handover_assignments a
            where a.handover_id=h.id and a.assigned_to_user_id=${input.userId}
          )
        )
      order by h.updated_at desc
      for update of h
    `)
    let candidateHandovers = (handoverResult.rows ?? []) as RelatedHandover[]
    let clinicalResult = candidateHandovers.length
      ? await tx.exec(sql`
          select p.id, p.handover_id, p.patient_key, p.display_name, p.location
          from handover_patients p
          where p.handover_id = any(${candidateHandovers.map((handover) => handover.id)}::text[])
          for update of p
        `)
      : { rows: [] }
    let clinicalPatients = (clinicalResult.rows ?? []) as ClinicalPatientIdentity[]
    let identityAlias = sheetPatient
      ? derivedPatientIdentityKey({
          displayName: sheetPatient.display_name,
          location: sheetPatient.location,
        })
      : null
    let matchedClinicalPatients = resolvePatientIdentityReferences(
      clinicalPatients.map((patient) => ({
        value: patient,
        key: patient.patient_key,
        displayName: patient.display_name,
        location: patient.location,
      })),
      input.patientKey,
      identityAlias,
    ).map((reference) => reference.value)
    let matchedLinkedHandovers = resolvePatientIdentityReferences(
      candidateHandovers.flatMap((handover) => handover.linked_patient_key ? [{
        value: handover,
        key: handover.linked_patient_key,
        displayName: handover.linked_patient_display_name,
        location: handover.linked_patient_location,
      }] : []),
      input.patientKey,
      identityAlias,
    ).map((reference) => reference.value)
    let relatedHandoverIds = new Set([
      ...matchedClinicalPatients.map((patient) => patient.handover_id),
      ...matchedLinkedHandovers.map((handover) => handover.id),
    ])
    let relatedHandovers = candidateHandovers.filter((handover) => relatedHandoverIds.has(handover.id))

    if (!sheetPatient && relatedHandovers.length === 0) return null
    if (input.handoverId && !relatedHandovers.some((handover) => handover.id === input.handoverId)) {
      return null
    }

    let at = new Date().toISOString()
    if (sheetPatient) {
      let fields = storedFields(sheetPatient.fields)
      fields = updateReviewedField(fields, 'name', displayName, input.userId, at)
      fields = updateReviewedField(fields, 'bed', location, input.userId, at)
      await tx.exec(sql`
        update shift_sheet_patients
        set display_name=${displayName}, location=${location},
          fields=${JSON.stringify(fields)}::jsonb, updated_at=now()
        where id=${sheetPatient.id}
      `)
    }

    let handoverIds = relatedHandovers.map((handover) => handover.id)
    let clinicalPatientIds = matchedClinicalPatients.map((patient) => patient.id)
    let promotePatientKey = Boolean(sheetPatient) || !isPlaceholderPatientKey(input.patientKey)
    if (handoverIds.length) {
      let taskResult = promotePatientKey
        ? await tx.exec(sql`
            select t.id, t.handover_id, t.patient_key, t.related_uncertainty_id
            from handover_tasks t
            where t.handover_id = any(${handoverIds}::text[])
            for update of t
          `)
        : { rows: [] }
      let handoverTasks = (taskResult.rows ?? []) as HandoverTaskIdentity[]
      if (clinicalPatientIds.length) {
        if (promotePatientKey) {
          await tx.exec(sql`
            update handover_patients
            set patient_key=${input.patientKey}, display_name=${displayName}, location=${location}
            where id = any(${clinicalPatientIds}::text[])
          `)
        } else {
          await tx.exec(sql`
            update handover_patients
            set display_name=${displayName}, location=${location}
            where id = any(${clinicalPatientIds}::text[])
          `)
        }
      }

      for (let handover of relatedHandovers) {
        let decodedAnalysis = decodeObject(handover.analysis)
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
          ...analysisPatientReferences(decodedAnalysis),
        ]
        let safeAliases = safePlaceholderPatientAliasKeys(
          identityReferences,
          input.patientKey,
          identityAlias,
        )
        let matchedAnalysisTaskIds = analysisPatientTaskIds(
          decodedAnalysis,
          input.patientKey,
          identityAlias,
        )
        let handoverTaskRows = handoverTasks.filter((task) => task.handover_id === handover.id)
        let targetKey = normalizePatientKey(input.patientKey)
        let migrationCandidates = handoverTaskRows.filter((task) =>
          task.patient_key !== input.patientKey
          && (
            normalizePatientKey(task.patient_key) === targetKey
            || safeAliases.has(normalizePatientKey(task.patient_key))
            || matchedAnalysisTaskIds.has(task.id)
          ),
        )
        let candidateIds = new Set(migrationCandidates.map((task) => task.id))
        let taskIds = migrationCandidates.filter((task) =>
          !task.related_uncertainty_id
          || !handoverTaskRows.some((candidate) =>
            candidate.id !== task.id
            && candidate.related_uncertainty_id === task.related_uncertainty_id
            && (
              normalizePatientKey(candidate.patient_key) === targetKey
              || candidateIds.has(candidate.id)
            ),
          ),
        ).map((task) => task.id)
        if (taskIds.length) {
          await tx.exec(sql`
            update handover_tasks
            set patient_key=${input.patientKey}, updated_at=now()
            where handover_id=${handover.id} and id = any(${taskIds}::text[])
          `)
        }
        let analysis = updateAnalysisPatient(
          decodedAnalysis,
          input.patientKey,
          identityAlias,
          displayName,
          location,
          promotePatientKey,
          safeAliases,
        )
        let linked = matchedLinkedHandovers.some((candidate) => candidate.id === handover.id)
        let title = linked ? updatedHandoverTitle(handover, displayName) : handover.title
        await tx.exec(sql`
          update handovers
          set title=${title},
            linked_patient_key=${linked && promotePatientKey ? input.patientKey : handover.linked_patient_key},
            linked_patient_display_name=${linked ? displayName : handover.linked_patient_display_name},
            linked_patient_location=${linked ? location : handover.linked_patient_location},
            analysis=${analysis == null ? null : JSON.stringify(analysis)}::jsonb,
            updated_at=now()
          where id=${handover.id} and shift_id=${input.shiftId}
        `)
      }
    }

    return {
      patientKey: input.patientKey,
      displayName,
      location,
      sheetUpdated: Boolean(sheetPatient),
      handoverIds,
    }
  })
}

function storedFields(value: unknown): HandoverSheetPatientField[] {
  let decoded = value
  if (typeof value === 'string') {
    try { decoded = JSON.parse(value) } catch { decoded = [] }
  }
  return Array.isArray(decoded)
    ? decoded.filter((field): field is HandoverSheetPatientField => Boolean(field) && typeof field === 'object')
    : []
}

function updateReviewedField(
  fields: HandoverSheetPatientField[],
  columnKey: 'name' | 'bed',
  value: string,
  userId: string,
  at: string,
) {
  let existing = fields.find((field) => field.columnKey === columnKey)
  let previousValue = existing
    ? existing.finalAcceptedValue ?? existing.humanReviewedValue ?? existing.value
    : ''
  let next: HandoverSheetPatientField = {
    ...(existing ?? {
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
    reviewDecision: 'edited',
    uncertain: false,
    reviewedAt: at,
    reviewedByUserId: userId,
    reviewEvents: [
      ...(existing?.reviewEvents ?? []),
      { at, byUserId: userId, previousValue, nextValue: value, method: 'human' as const },
    ].slice(-20),
  }
  return existing
    ? fields.map((field) => field === existing ? next : field)
    : [...fields, next]
}

function updateAnalysisPatient(
  analysis: Record<string, unknown> | null,
  patientKey: string,
  identityAlias: string | null,
  displayName: string,
  location: string,
  promotePatientKey: boolean,
  safeAliases: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (!analysis) return null
  let patientWorksheetFields = migrateAnalysisPatientWorksheetFields(
    analysis.patientWorksheetFields,
    safeAliases,
    patientKey,
  )
  if (!Array.isArray(analysis.patients)) {
    return {
      ...analysis,
      ...(patientWorksheetFields ? { patientWorksheetFields } : {}),
    }
  }
  let patients = analysisPatientIdentityReferences(analysis)
  let matchedPatients = new Set(
    resolvePatientIdentityReferences(patients, patientKey, identityAlias).map((reference) => reference.value),
  )
  return {
    ...analysis,
    ...(patientWorksheetFields ? { patientWorksheetFields } : {}),
    patients: analysis.patients.map((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate
      let patient = candidate as Record<string, unknown>
      return matchedPatients.has(patient)
        ? {
            ...patient,
            ...(promotePatientKey ? { patientKey } : {}),
            displayName,
            location,
          }
        : patient
    }),
  }
}

function analysisPatientReferences(analysis: Record<string, unknown> | null) {
  return analysisPatientIdentityReferences(analysis).map((patient) => ({
    key: patient.key,
    displayName: patient.displayName,
    location: patient.location,
  }))
}

function analysisPatientIdentityReferences(analysis: Record<string, unknown> | null) {
  if (!Array.isArray(analysis?.patients)) return []
  return analysis.patients.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    let patient = candidate as Record<string, unknown>
    return [{
      value: patient,
      key: typeof patient.patientKey === 'string' ? patient.patientKey : '',
      displayName: typeof patient.displayName === 'string' ? patient.displayName : '',
      location: typeof patient.location === 'string' ? patient.location : '',
    }]
  })
}

function analysisPatientTaskIds(
  analysis: Record<string, unknown> | null,
  patientKey: string,
  identityAlias: string | null,
) {
  let patients = analysisPatientIdentityReferences(analysis)
  let matchedPatients = new Set(resolvePatientIdentityReferences(
    patients,
    patientKey,
    identityAlias,
  ).map(({ value }) => value))
  let patientsByTaskId = new Map<string, Set<Record<string, unknown>>>()
  for (let { value: patient } of patients) {
    if (!Array.isArray(patient.tasks)) continue
    for (let candidate of patient.tasks) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      let id = (candidate as Record<string, unknown>).id
      if (typeof id !== 'string' || !id.trim()) continue
      let candidatePatients = patientsByTaskId.get(id) ?? new Set<Record<string, unknown>>()
      candidatePatients.add(patient)
      patientsByTaskId.set(id, candidatePatients)
    }
  }
  return new Set([...patientsByTaskId].flatMap(([id, candidatePatients]) => {
    if (candidatePatients.size !== 1) return []
    let [patient] = candidatePatients
    return patient && matchedPatients.has(patient) ? [id] : []
  }))
}

function migrateAnalysisPatientWorksheetFields(
  value: unknown,
  aliases: ReadonlySet<string>,
  patientKey: string,
) {
  let collection = decodeObject(value)
  if (!collection) return null
  let patientIdentityKey = normalizePatientKey(patientKey)
  let aliasFields = Object.entries(collection).flatMap(([key, fields]) =>
    normalizePatientKey(key) !== patientIdentityKey && aliases.has(normalizePatientKey(key)) ? [fields] : [],
  )
  if (!aliasFields.length) return collection
  let fields = new Map<string, HandoverSheetPatientField>()
  for (let source of [...aliasFields, collection[patientKey]]) {
    for (let field of normalizeStoredHandoverSheetFields(source)) fields.set(field.columnKey, field)
  }
  let next = Object.fromEntries(Object.entries(collection).filter(([key]) => {
    let normalizedKey = normalizePatientKey(key)
    return normalizedKey === patientIdentityKey || !aliases.has(normalizedKey)
  }))
  return { ...next, [patientKey]: [...fields.values()] }
}

function decodeObject(value: unknown): Record<string, unknown> | null {
  let decoded = value
  if (typeof value === 'string') {
    try { decoded = JSON.parse(value) } catch { return null }
  }
  return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
    ? decoded as Record<string, unknown>
    : null
}

function updatedHandoverTitle(handover: RelatedHandover, displayName: string) {
  if (handover.direction === 'outgoing' && /^(?:Delivering|Outgoing) handover ·/.test(handover.title)) {
    return `Delivering handover · ${displayName}`.slice(0, 120)
  }
  if (handover.direction === 'intra-shift' && /^(?:Intra-shift|Another) handover ·/.test(handover.title)) {
    return `Intra-shift handover · ${displayName}`.slice(0, 120)
  }
  return handover.title
}
