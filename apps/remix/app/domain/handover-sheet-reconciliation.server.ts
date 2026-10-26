import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import type { Database } from 'remix/data-table'
import { z } from 'zod'

import {
  handoverSheetColumns,
  handoverSheetLabels,
  type HandoverSheetPatientField,
} from '../data/handover-sheet.ts'
import type { AnalysisSummary, DspySpan } from './handover-analysis.server.ts'
import {
  listStoredHandoverSheetReconciliationTargets,
  persistHandoverSheetSbarChanges,
} from '../data/repository.ts'

const sbarSectionSchema = z.enum(['situation', 'background', 'assessment', 'recommendation'])
const handoverSheetColumnSchema = z.enum(handoverSheetColumns)
const reconciliationOutputSchema = z.object({
  changes: z.array(z.object({
    columnKey: handoverSheetColumnSchema,
    nextValue: z.string().max(4_000),
    sbarSection: sbarSectionSchema,
    summaryQuote: z.string().max(500),
    rationale: z.string().max(500),
  })).max(8),
})

export type HandoverSheetSbarReconciliationChange = z.infer<typeof reconciliationOutputSchema>['changes'][number]

export type HandoverSheetSbarReconciliationInput = {
  handoverId: string
  handoverTitle: string
  patient: {
    patientKey: string
    displayName: string
    location: string
  }
  sheetFields: HandoverSheetPatientField[]
  structuredSummary: AnalysisSummary
  sbarEvidence?: DspySpan[]
}

type ReconciliationRequest = {
  instructions: string
  input: string
  schema: typeof reconciliationOutputSchema
  schemaName: 'handover_sheet_sbar_reconciliation'
}

export interface HandoverSheetReconciliationRequester {
  request(request: ReconciliationRequest): Promise<unknown>
}

const RECONCILIATION_INSTRUCTIONS = [
  'Compare one digitised nursing ward handover-sheet row with the completed SBAR summary from a verbal handover for the same patient.',
  'Return strict structured data only.',
  'Only return a change when the SBAR clearly adds clinically useful information, corrects an outdated fact, or fills a blank sheet cell.',
  'Never invent information and never remove existing information unless the SBAR explicitly says it is wrong or superseded.',
  'Use concise ward-handover wording and preserve important abbreviations, negations, dates, medication names, allergies, units, and escalation triggers.',
  'Do not update Bed or Name unless the SBAR explicitly corrects the patient identity or location.',
  'nextValue must be the complete replacement text for the cell, retaining still-current sheet information where appropriate.',
  'summaryQuote must be a short exact excerpt from the named SBAR section that justifies the change.',
  'Return no changes when the evidence does not justify one.',
].join(' ')

function finalFieldValue(field: HandoverSheetPatientField): string {
  return (field.finalAcceptedValue ?? field.humanReviewedValue ?? field.value ?? '').trim()
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function summaryContainsQuote(summary: AnalysisSummary, section: HandoverSheetSbarReconciliationChange['sbarSection'], quote: string): boolean {
  let source = normalized(summary[section])
  let candidate = normalized(quote)
  return Boolean(candidate && source.includes(candidate))
}

export function createHandoverSheetReconciliationPrompt(input: HandoverSheetSbarReconciliationInput): string {
  let currentSheet = handoverSheetColumns.map((columnKey) => {
    let field = input.sheetFields.find((candidate) => candidate.columnKey === columnKey)
    return {
      columnKey,
      label: handoverSheetLabels[columnKey],
      value: field ? finalFieldValue(field) : '',
    }
  })
  return JSON.stringify({
    patient: input.patient,
    currentSheet,
    sbarSummary: input.structuredSummary,
    sbarEvidence: input.sbarEvidence?.slice(0, 12) ?? [],
  })
}

export function createOpenAIHandoverSheetReconciliationRequester(options: {
  apiKey: string
  model?: string
  timeoutMs?: number
}): HandoverSheetReconciliationRequester {
  if (!options.apiKey.trim()) throw new Error('OPENAI_API_KEY is required for handover sheet reconciliation.')
  let client = new OpenAI({
    apiKey: options.apiKey,
    maxRetries: 0,
    timeout: options.timeoutMs ?? 120_000,
  })
  return {
    async request(request) {
      let response = await client.responses.create({
        model: options.model?.trim() || 'gpt-5.5',
        store: false,
        instructions: request.instructions,
        input: request.input,
        text: { format: zodTextFormat(request.schema, request.schemaName) },
      })
      if (!response.output_text) {
        throw new Error(`OpenAI returned no handover sheet reconciliation (status: ${response.status ?? 'unknown'}).`)
      }
      try { return JSON.parse(response.output_text) as unknown }
      catch { throw new Error('OpenAI returned invalid JSON for handover sheet reconciliation.') }
    },
  }
}

export function createConfiguredOpenAIHandoverSheetReconciliationRequester(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HandoverSheetReconciliationRequester {
  let timeout = Number(env.OPENAI_REQUEST_TIMEOUT_MS)
  return createOpenAIHandoverSheetReconciliationRequester({
    apiKey: env.OPENAI_API_KEY ?? '',
    model: env.OPENAI_MODEL,
    timeoutMs: Number.isSafeInteger(timeout) && timeout > 0 ? timeout : 120_000,
  })
}

export async function reconcileHandoverSheetWithSbar(
  input: HandoverSheetSbarReconciliationInput,
  dependencies: { requester: HandoverSheetReconciliationRequester },
): Promise<HandoverSheetSbarReconciliationChange[]> {
  let raw = await dependencies.requester.request({
    instructions: RECONCILIATION_INSTRUCTIONS,
    input: createHandoverSheetReconciliationPrompt(input),
    schema: reconciliationOutputSchema,
    schemaName: 'handover_sheet_sbar_reconciliation',
  })
  let parsed = reconciliationOutputSchema.parse(raw)
  let seen = new Set<string>()
  return parsed.changes.flatMap((change): HandoverSheetSbarReconciliationChange[] => {
    let nextValue = change.nextValue.trim().slice(0, 4_000)
    let summaryQuote = change.summaryQuote.trim().slice(0, 500)
    let rationale = change.rationale.trim().slice(0, 500)
    let identity = `${change.columnKey}:${normalized(nextValue)}`
    if (!nextValue || !summaryQuote || !rationale || seen.has(identity)) return []
    if (!summaryContainsQuote(input.structuredSummary, change.sbarSection, summaryQuote)) return []
    seen.add(identity)
    return [{ ...change, nextValue, summaryQuote, rationale }]
  })
}

/** Reconciles every unambiguous sheet row linked to one completed handover revision. */
export async function reconcileStoredHandoverSheetWithSbar(
  db: Database,
  input: {
    handoverId: string
    requester: HandoverSheetReconciliationRequester
    now?: Date
  },
): Promise<number> {
  let targets = await listStoredHandoverSheetReconciliationTargets(db, input.handoverId)
  let persisted = 0
  for (let target of targets) {
    let changes = await reconcileHandoverSheetWithSbar(target, { requester: input.requester })
    persisted += await persistHandoverSheetSbarChanges(db, {
      target,
      changes,
      at: input.now,
    })
  }
  return persisted
}
