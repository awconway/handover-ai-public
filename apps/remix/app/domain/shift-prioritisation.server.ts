import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import { type Database } from 'remix/data-table'
import { z } from 'zod'

import {
  getShiftForUser,
  handoversHaveLocalFirstProcessingHistory,
  listHandoversForUser,
  listShiftHandoverPatientsForUser,
  listShiftSheetPatientsForUser,
  listTasksForUser,
  setShiftPatientOrder,
} from '../data/repository.ts'
import { resolveLocalFirstProcessingPolicy } from '../data/local-first-processing.ts'
import { isPlaceholderPatientKey } from '../data/patient-identity.ts'

const shiftPrioritisationSchema = z.object({
  patientKeys: z.array(z.string().min(1)).min(1),
})

const instructions = [
  'Outcome: produce patientKeys ordered from first to last for outgoing handover on a clinical shift board.',
  'Success criteria: include every supplied patientKey exactly once, include no unknown keys, rank from supplied clinical/workflow evidence, and preserve currentOrderIndex when evidence is sparse or clinically similar.',
  'Use only the supplied patient-level shift context; absent information should not create urgency.',
  'Primary factors, in order: immediate clinical urgency, unresolved high-risk issue, time-critical outstanding task, blocking uncertainty, and transfer or workflow dependency.',
  'Secondary factor: patients without a completed outgoing handover should generally come earlier, unless supplied clinical context shows another patient is more urgent.',
  'Use currentOrderIndex/input order as the tie-breaker; avoid alphabetical ordering.',
  'Stopping condition: once patientKeys is complete, stop without adding rationale.',
].join(' ')

export type ShiftPrioritisationRequester = (input: {
  instructions: string
  input: string
}) => Promise<unknown>

type ShiftPrioritisationOptions = {
  requester?: ShiftPrioritisationRequester
  localFirstRequester?: (denyTerms: readonly ShiftPrivacyDenyTerm[]) => ShiftPrioritisationRequester
}

export type ShiftPrivacyDenyTerm = { term: string; label: string }

export function shiftPrioritisationPrivacySourceIds(input: {
  allHandovers: Array<{ id: string; source_handover_id?: string | null }>
  shiftHandovers: Array<{ id: string }>
  clinicalRows: Array<{ handover_id: string }>
}): string[] {
  let byId = new Map(input.allHandovers.map((handover) => [handover.id, handover]))
  let contributingIds = new Set([
    ...input.shiftHandovers.map((handover) => handover.id),
    ...input.clinicalRows.map((row) => row.handover_id),
  ])
  return [...new Set([...contributingIds].flatMap((id) => [
    id,
    byId.get(id)?.source_handover_id,
  ]).filter((id): id is string => typeof id === 'string' && id.length > 0))]
}

export async function prioritiseShiftBoard(
  db: Database,
  input: { shiftId: string; userId: string },
  options: ShiftPrioritisationOptions = {},
) {
  let shift = await getShiftForUser(db, input.shiftId, input.userId)
  if (!shift) return null

  let [sheetPatients, clinicalRows, allHandovers, allTasks] = await Promise.all([
    listShiftSheetPatientsForUser(db, input),
    listShiftHandoverPatientsForUser(db, input),
    listHandoversForUser(db, input.userId),
    listTasksForUser(db, input.userId),
  ])
  if (!sheetPatients) return null

  let handovers = allHandovers.filter((handover) => handover.shift_id === shift.id)
  let knownKeys = new Set(shift.patient_order)
  for (let patient of sheetPatients) knownKeys.add(patient.patient_key)
  for (let patient of clinicalRows) knownKeys.add(patient.patient_key)
  for (let handover of handovers) if (handover.linked_patient_key) knownKeys.add(handover.linked_patient_key)

  let orderIndex = new Map(shift.patient_order.map((key, index) => [key, index]))
  let sheetIndex = new Map(sheetPatients.map((patient) => [patient.patient_key, patient.row_index]))
  let patientKeys = [...knownKeys].sort((left, right) => {
    let leftOrder = orderIndex.get(left)
    let rightOrder = orderIndex.get(right)
    if (leftOrder != null || rightOrder != null) return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER)
    return (sheetIndex.get(left) ?? Number.MAX_SAFE_INTEGER) - (sheetIndex.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right)
  })
  if (patientKeys.length < 2) return shift

  let contexts = patientKeys.map((patientKey, currentOrderIndex) => {
    let sheetPatient = sheetPatients.find((patient) => patient.patient_key === patientKey)
    let rows = clinicalRows.filter((patient) => patient.patient_key === patientKey)
    let linked = handovers.filter((handover) =>
      handover.linked_patient_key === patientKey || rows.some((row) => row.handover_id === handover.id),
    )
    let relevant = linked.find((handover) => handover.processing_status === 'completed' && handover.analysis)
      ?? linked.find((handover) => handover.analysis)
      ?? linked[0]
    let analysis = record(relevant?.analysis)
    let analysisPatient = records(analysis?.patients).find((patient) => patient.patientKey === patientKey)
      ?? records(analysis?.patients)[0]
    let tasks = allTasks.filter((task) => task.patient_key === patientKey && linked.some((handover) => handover.id === task.handover_id) && task.status !== 'done')
    let latestRow = rows[0]
    return {
      currentOrderIndex,
      patientKey,
      displayName: sheetPatient?.display_name ?? latestRow?.display_name ?? linked.find((handover) => handover.linked_patient_display_name)?.linked_patient_display_name ?? patientKey,
      location: sheetPatient?.location ?? latestRow?.location ?? linked.find((handover) => handover.linked_patient_location)?.linked_patient_location ?? '',
      hasOutgoingHandover: linked.some((handover) => handover.direction === 'outgoing'),
      handoverCount: linked.length,
      openTaskCount: tasks.length,
      latestHandoverAt: relevant ? timestamp(relevant.updated_at) : null,
      latestHandoverTitle: relevant?.title ?? null,
      headline: text(analysis?.headline) || null,
      overview: text(analysis?.overview) || null,
      structuredSummary: record(analysis?.structuredSummary),
      keyRisks: strings(analysisPatient?.keyRisks),
      outstandingTasks: tasks.map((task) => `${task.priority}: ${task.title} (${task.due_label || 'No due date set'})`),
      uncertainties: records(analysisPatient?.uncertainties).map((uncertainty) => text(uncertainty.statement)).filter(Boolean),
    }
  })

  // Completed recipient copies intentionally have no copied job row. Include
  // their authoritative source so local-first provenance survives assignment.
  let privacySourceIds = shiftPrioritisationPrivacySourceIds({
    allHandovers,
    shiftHandovers: handovers,
    clinicalRows,
  })
  let localFirstHistory = await handoversHaveLocalFirstProcessingHistory(db, privacySourceIds)
  let requiresLocalPrivacy = resolveLocalFirstProcessingPolicy() === 'required'
    || localFirstHistory
  let denyTerms: ShiftPrivacyDenyTerm[] = []
  for (let context of contexts) {
    if (!isPlaceholderPatientKey(context.patientKey)) {
      denyTerms.push({ term: context.patientKey, label: 'ID_NUM' })
    }
    if (context.displayName.trim()) {
      denyTerms.push({ term: context.displayName, label: 'PERSON' })
    }
  }
  let request = requiresLocalPrivacy
    ? options.localFirstRequester?.(denyTerms)
    : options.requester ?? createConfiguredRequester()
  if (!request) throw new Error('Local privacy is required for shift prioritisation.')
  let parsed = shiftPrioritisationSchema.parse(await request({
    instructions,
    input: JSON.stringify({
      shift: { id: shift.id, title: shift.title, department: shift.department, notes: shift.notes },
      patients: contexts,
    }, null, 2),
  }))
  let proposed = [...new Set(parsed.patientKeys)].filter((key) => knownKeys.has(key))
  let completeOrder = [...proposed, ...patientKeys.filter((key) => !proposed.includes(key))]
  return setShiftPatientOrder(db, { id: shift.id, userId: input.userId, patientOrder: completeOrder })
}

export function createConfiguredRequester(env: Readonly<Record<string, string | undefined>> = process.env): ShiftPrioritisationRequester {
  let apiKey = env.OPENAI_API_KEY?.trim()
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.')
  let client = new OpenAI({ apiKey, maxRetries: 0, timeout: positiveInteger(env.OPENAI_REQUEST_TIMEOUT_MS, 120_000) })
  return async (input) => {
    let response = await client.responses.create({
      model: env.OPENAI_MODEL?.trim() || 'gpt-5.5',
      store: false,
      reasoning: { effort: reasoningEffort(env.OPENAI_MODEL_REASONING_EFFORT) },
      instructions: input.instructions,
      input: input.input,
      text: { format: zodTextFormat(shiftPrioritisationSchema, 'shift_prioritisation') },
    })
    if (!response.output_text) throw new Error(`OpenAI returned no shift prioritisation (status: ${response.status ?? 'unknown'}).`)
    try { return JSON.parse(response.output_text) as unknown } catch { throw new Error('OpenAI returned invalid shift prioritisation JSON.') }
  }
}

function record(value: unknown): Record<string, any> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : null }
function records(value: unknown): Array<Record<string, any>> { return Array.isArray(value) ? value.map(record).filter((item): item is Record<string, any> => item !== null) : [] }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] }
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function timestamp(value: Date | string): string { return value instanceof Date ? value.toISOString() : String(value) }
function positiveInteger(value: string | undefined, fallback: number) { let number = Number(value); return Number.isInteger(number) && number > 0 ? number : fallback }
function reasoningEffort(value: string | undefined): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  return value === 'none' || value === 'minimal' || value === 'low' || value === 'high' || value === 'xhigh' ? value : 'medium'
}
