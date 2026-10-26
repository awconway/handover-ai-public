import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import {
  normalizePatientKey,
  safePlaceholderPatientAliasKeys,
} from './patient-identity.ts'
import type { UploadInput } from './upload-storage.ts'
import { sheetUploadPolicy, validateUpload } from './upload-storage.ts'

export const handoverSheetColumns = [
  'bed', 'name', 'alerts_allergies', 'consultant', 'diagnosis', 'background', 'diet',
  'mobility_fall', 'assessment_management', 'edd', 'planning',
] as const
export type HandoverSheetColumnKey = typeof handoverSheetColumns[number]
export type HandoverSheetReviewDecision = 'accepted' | 'edited' | 'rejected'
export type HandoverSheetReviewEvent = {
  at: string
  byUserId: string
  previousValue: string
  nextValue: string
  method: 'human' | 'llm' | 'automatic'
}
export type HandoverSheetSbarUpdateEvent = {
  at: string
  handoverId: string
  handoverTitle: string
  sbarSection: 'situation' | 'background' | 'assessment' | 'recommendation'
  previousValue: string
  nextValue: string
  summaryQuote: string
  rationale: string
}
export type HandoverSheetPatientField = {
  label: string; value: string; columnKey: HandoverSheetColumnKey;
  reviewStatus: 'automatic' | 'needs_review' | 'human_verified' | 'llm_adjudicated';
  reviewMethod: 'automatic' | 'human' | 'llm'; uncertain: boolean; issues: string[];
  alternatives?: string[]; humanReviewedValue?: string | null; finalAcceptedValue?: string | null;
  llmAdjudicatedValue?: string | null; llmUncertain?: boolean | null; llmIssue?: string | null;
  reviewedAt?: string | null; reviewedByUserId?: string | null;
  reviewDecision?: HandoverSheetReviewDecision
  imageQualityIssues?: string[]
  reviewEvents?: HandoverSheetReviewEvent[]
  sbarUpdateEvents?: HandoverSheetSbarUpdateEvent[]
  templateVersion?: string;
}
export type PatientWorksheetField = {
  key: HandoverSheetColumnKey
  label: string
  value: string
  editValue: string
  hasCapturedValue: boolean
  multiline: boolean
  confidence: 'high' | 'medium' | 'low'
  status: 'pending' | 'accepted' | 'edited' | 'rejected'
  reviewStatus: HandoverSheetPatientField['reviewStatus']
  reviewMethod: HandoverSheetPatientField['reviewMethod']
  uncertain: boolean
  issues: string[]
  imageQualityIssues: string[]
  alternatives: string[]
  reviewEvents: HandoverSheetReviewEvent[]
  sbarUpdateEvents: HandoverSheetSbarUpdateEvent[]
}
export type ParsedHandoverSheetPatient = { displayName: string; location: string; fields: HandoverSheetPatientField[]; rawText: string }
export type HandoverSheetExtraction = {
  fileName: string; contentType: string; method: 'text' | 'image-llm' | 'pdf-llm'; patients: ParsedHandoverSheetPatient[];
  sourceFileSizeBytes: number
}

export const handoverSheetLabels: Record<HandoverSheetColumnKey, string> = {
  bed: 'Bed', name: 'Name', alerts_allergies: 'Alerts / Allergies', consultant: 'Consultant', diagnosis: 'Diagnosis',
  background: 'Background', diet: 'Diet', mobility_fall: 'Mobility/Fall', assessment_management: 'Assessment and Management',
  edd: 'EDD', planning: 'Planning',
}
const aliases: Record<string, HandoverSheetColumnKey> = {
  bed: 'bed', bedspace: 'bed', room: 'bed', bay: 'bed', location: 'bed', name: 'name', patient: 'name', patientname: 'name',
  alerts: 'alerts_allergies', allergies: 'alerts_allergies', alertsallergies: 'alerts_allergies', consultant: 'consultant', team: 'consultant',
  diagnosis: 'diagnosis', problem: 'diagnosis', background: 'background', history: 'background', diet: 'diet', nutrition: 'diet',
  mobility: 'mobility_fall', mobilityfall: 'mobility_fall', falls: 'mobility_fall', assessment: 'assessment_management',
  management: 'assessment_management', assessmentandmanagement: 'assessment_management', edd: 'edd', estimateddateofdischarge: 'edd',
  planning: 'planning', dischargeplanning: 'planning',
}

export class HandoverSheetExtractionError extends Error { status = 422 }
const execFileAsync = promisify(execFile)
const MAX_CONVERTED_IMAGE_BYTES = 30 * 1024 * 1024
export const MAX_HANDOVER_SHEET_ROWS = 5_000
export const MAX_HANDOVER_SHEET_COLUMNS = 128
const clean = (value: string) => value.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim()
const headerKey = (value: string) => clean(value).toLowerCase().replace(/[^a-z0-9]/g, '')

const documentCellIssueSchema = z.enum([
  'none',
  'blur',
  'cropped',
  'low_resolution',
  'ambiguous_characters',
  'unreadable',
])
const documentImageIssueSchema = z.enum([
  'none',
  'blur',
  'glare',
  'shadow',
  'rotation',
  'perspective',
  'low_resolution',
  'cropped',
  'not_handover_sheet',
  'unreadable',
])
const documentCellSchema = z.object({
  verbatim: z.string().nullable(),
  uncertain: z.boolean(),
  alternatives: z.array(z.string()).max(6),
  issue: documentCellIssueSchema,
})
const documentExtractionSchema = z.object({
  templateDetected: z.boolean(),
  imageIssue: documentImageIssueSchema,
  extractionComplete: z.boolean(),
  omittedRowCount: z.number().int().nonnegative().nullable(),
  rows: z.array(z.object({
    rowNumber: z.number().int().positive(),
    cells: z.object(Object.fromEntries(
      handoverSheetColumns.map((column) => [column, documentCellSchema]),
    ) as Record<HandoverSheetColumnKey, typeof documentCellSchema>),
  })),
})

const DOCUMENT_EXTRACTION_INSTRUCTIONS = [
  'Extract the fixed-layout nursing ward handover sheet from the uploaded document.',
  'Return strict structured data only.',
  `The canonical columns, in order, are: ${handoverSheetColumns.join(', ')}.`,
  'Read every patient row independently and do not combine patients.',
  'Transcribe only visible text. Never infer clinical facts, repair spelling, expand abbreviations, or normalise dates or units.',
  'Preserve clinical negation, punctuation, numbers, medication names, allergy statements, abbreviations, and visible line order.',
  'For each cell, return verbatim null when it is blank or unreadable, mark uncertainty, report the image issue, and include up to six plausible visible alternatives when characters are ambiguous.',
  'If the document is not the expected table, set templateDetected false and return no rows.',
  'If any patient row might be omitted because the image is cropped, unreadable, or too large, set extractionComplete false and estimate omittedRowCount.',
].join(' ')

function parseDelimitedRows(text: string, delimiter?: string): string[][] {
  let selected = delimiter ?? ([',', '\t', '|'].map((value) => ({ value, count: text.slice(0, 3000).split(value).length })).sort((a, b) => b.count - a.count)[0]?.value ?? ',')
  let rows: string[][] = [], row: string[] = [], cell = '', quoted = false
  let pushCell = () => {
    if (row.length >= MAX_HANDOVER_SHEET_COLUMNS) {
      throw new HandoverSheetExtractionError(`Handover sheets can contain at most ${MAX_HANDOVER_SHEET_COLUMNS} columns.`)
    }
    row.push(clean(cell))
    cell = ''
  }
  let pushRow = () => {
    pushCell()
    if (row.some(Boolean)) {
      if (rows.length >= MAX_HANDOVER_SHEET_ROWS + 1) {
        throw new HandoverSheetExtractionError(`Handover sheets can contain at most ${MAX_HANDOVER_SHEET_ROWS} patient rows.`)
      }
      rows.push(row)
    }
    row = []
  }
  for (let i = 0; i < text.length; i++) {
    let char = text[i]!, next = text[i + 1]
    if (char === '"') { if (quoted && next === '"') { cell += '"'; i++ } else quoted = !quoted; continue }
    if (!quoted && char === selected) { pushCell(); continue }
    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') i++
      pushRow(); continue
    }
    cell += char
  }
  pushRow()
  return rows
}

function field(columnKey: HandoverSheetColumnKey, value: string, method: 'automatic' | 'llm'): HandoverSheetPatientField {
  let issues = !value ? ['blank'] : columnKey === 'alerts_allergies' && /allerg|latex|penicillin|sensitivity/i.test(value) ? ['clinical_risk_requires_human_review'] : []
  return { label: handoverSheetLabels[columnKey], columnKey, value, reviewStatus: method === 'llm' || issues.length ? 'needs_review' : 'automatic', reviewMethod: method, uncertain: method === 'llm' || issues.length > 0, issues, templateVersion: 'ward-handover-v1' }
}

const multilineColumns = new Set<HandoverSheetColumnKey>([
  'background',
  'assessment_management',
  'planning',
])

function isColumnKey(value: unknown): value is HandoverSheetColumnKey {
  return typeof value === 'string' && handoverSheetColumns.includes(value as HandoverSheetColumnKey)
}

function text(value: unknown, max = 4_000): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function optionalText(value: unknown, max = 4_000): string | null | undefined {
  return value === null ? null : typeof value === 'string' ? value.slice(0, max) : undefined
}

function textList(value: unknown, maxItems = 12, maxLength = 1_000): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim().slice(0, maxLength)] : []).slice(0, maxItems)
    : []
}

function normalizeReviewStatus(value: unknown): HandoverSheetPatientField['reviewStatus'] {
  return value === 'needs_review' || value === 'human_verified' || value === 'llm_adjudicated'
    ? value
    : 'automatic'
}

function normalizeReviewMethod(value: unknown): HandoverSheetPatientField['reviewMethod'] {
  return value === 'human' || value === 'llm' ? value : 'automatic'
}

function normalizeReviewDecision(value: unknown): HandoverSheetReviewDecision | undefined {
  return value === 'accepted' || value === 'edited' || value === 'rejected' ? value : undefined
}

function normalizeReviewEvents(value: unknown): HandoverSheetReviewEvent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate): HandoverSheetReviewEvent[] => {
    if (!candidate || typeof candidate !== 'object') return []
    let event = candidate as Record<string, unknown>
    let method = normalizeReviewMethod(event.method)
    if (!text(event.at, 80) || !text(event.byUserId, 160)) return []
    return [{
      at: text(event.at, 80),
      byUserId: text(event.byUserId, 160),
      previousValue: text(event.previousValue),
      nextValue: text(event.nextValue),
      method,
    }]
  }).slice(-20)
}

function normalizeSbarUpdateEvents(value: unknown): HandoverSheetSbarUpdateEvent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate): HandoverSheetSbarUpdateEvent[] => {
    if (!candidate || typeof candidate !== 'object') return []
    let event = candidate as Record<string, unknown>
    let section = event.sbarSection
    if (section !== 'situation' && section !== 'background' && section !== 'assessment' && section !== 'recommendation') return []
    if (!text(event.at, 80) || !text(event.handoverId, 160)) return []
    return [{
      at: text(event.at, 80),
      handoverId: text(event.handoverId, 160),
      handoverTitle: text(event.handoverTitle, 240),
      sbarSection: section,
      previousValue: text(event.previousValue),
      nextValue: text(event.nextValue),
      summaryQuote: text(event.summaryQuote),
      rationale: text(event.rationale),
    }]
  }).slice(-20)
}

function normalizeStoredHandoverSheetField(value: unknown): HandoverSheetPatientField | null {
  if (!value || typeof value !== 'object') return null
  let candidate = value as Record<string, unknown>
  let label = text(candidate.label, 160)
  let columnKey = isColumnKey(candidate.columnKey)
    ? candidate.columnKey
    : aliases[headerKey(label)]
  if (!columnKey) return null
  return {
    label: label || handoverSheetLabels[columnKey],
    columnKey,
    value: text(candidate.value),
    reviewStatus: normalizeReviewStatus(candidate.reviewStatus),
    reviewMethod: normalizeReviewMethod(candidate.reviewMethod),
    uncertain: candidate.uncertain === true,
    issues: textList(candidate.issues),
    imageQualityIssues: textList(candidate.imageQualityIssues),
    alternatives: textList(candidate.alternatives, 6, 4_000),
    llmAdjudicatedValue: optionalText(candidate.llmAdjudicatedValue),
    llmUncertain: typeof candidate.llmUncertain === 'boolean' ? candidate.llmUncertain : null,
    llmIssue: optionalText(candidate.llmIssue, 160),
    humanReviewedValue: optionalText(candidate.humanReviewedValue),
    finalAcceptedValue: optionalText(candidate.finalAcceptedValue),
    reviewedAt: optionalText(candidate.reviewedAt, 80),
    reviewedByUserId: optionalText(candidate.reviewedByUserId, 160),
    reviewDecision: normalizeReviewDecision(candidate.reviewDecision),
    reviewEvents: normalizeReviewEvents(candidate.reviewEvents),
    sbarUpdateEvents: normalizeSbarUpdateEvents(candidate.sbarUpdateEvents),
    templateVersion: text(candidate.templateVersion, 160) || undefined,
  }
}

export function normalizeStoredHandoverSheetFields(value: unknown): HandoverSheetPatientField[] {
  return Array.isArray(value)
    ? value.map(normalizeStoredHandoverSheetField).filter((field): field is HandoverSheetPatientField => field !== null)
    : []
}

/**
 * Reads manual worksheet reviews stored with a handover analysis. These are
 * used only when the shift has no imported sheet row for the patient.
 */
export function patientWorksheetFieldsFromAnalysis(
  value: unknown,
  patientKey: string,
): HandoverSheetPatientField[] {
  let decoded = value
  if (typeof decoded === 'string') {
    try { decoded = JSON.parse(decoded) } catch { return [] }
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return []
  let analysis = decoded as Record<string, unknown>
  let collection = analysis.patientWorksheetFields
  if (!collection || typeof collection !== 'object' || Array.isArray(collection)) return []
  let stored = collection as Record<string, unknown>
  let targetKey = normalizePatientKey(patientKey)
  let references = Array.isArray(analysis.patients)
    ? analysis.patients.flatMap((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
        let patient = candidate as Record<string, unknown>
        return [{
          key: typeof patient.patientKey === 'string' ? patient.patientKey : '',
          displayName: typeof patient.displayName === 'string' ? patient.displayName : '',
          location: typeof patient.location === 'string' ? patient.location : '',
        }]
      })
    : []
  let safeAliases = safePlaceholderPatientAliasKeys(references, patientKey)
  let sources = Object.entries(stored).flatMap(([key, fields]) => {
    let normalizedKey = normalizePatientKey(key)
    return normalizedKey !== targetKey && safeAliases.has(normalizedKey) ? [fields] : []
  })
  let exact = Object.entries(stored).find(([key]) => normalizePatientKey(key) === targetKey)?.[1]
  let fields = new Map<HandoverSheetColumnKey, HandoverSheetPatientField>()
  for (let source of [...sources, exact]) {
    for (let field of normalizeStoredHandoverSheetFields(source)) fields.set(field.columnKey, field)
  }
  return [...fields.values()]
}

function acceptedValue(field: HandoverSheetPatientField): string {
  return field.finalAcceptedValue ?? field.humanReviewedValue ?? field.value
}

function worksheetStatus(field: HandoverSheetPatientField): PatientWorksheetField['status'] {
  if (field.reviewDecision) return field.reviewDecision
  if (field.reviewStatus === 'needs_review') return 'pending'
  if (field.reviewStatus !== 'human_verified') return 'accepted'
  let previous = field.reviewEvents?.at(-1)?.previousValue ?? field.value
  return acceptedValue(field).trim() === previous.trim() ? 'accepted' : 'edited'
}

/**
 * Builds the fixed patient handover-sheet contract from persisted JSON fields.
 * Missing columns remain visible, while Bed and Name fall back to the patient
 * identity only when the imported row did not contain those fields at all.
 */
export function buildPatientWorksheetFields(
  rawFields: unknown,
  patient: { displayName: string; location?: string | null },
): PatientWorksheetField[] {
  let stored = normalizeStoredHandoverSheetFields(rawFields)

  return handoverSheetColumns.map((key) => {
    let field = stored.find((candidate) => candidate.columnKey === key)
    let fallback = key === 'bed' ? text(patient.location, 4_000) : key === 'name' ? text(patient.displayName, 4_000) : ''
    if (!field) {
      return {
        key,
        label: handoverSheetLabels[key],
        value: fallback || `${handoverSheetLabels[key]} not captured`,
        editValue: fallback,
        hasCapturedValue: Boolean(fallback.trim()),
        multiline: multilineColumns.has(key),
        confidence: fallback ? 'high' : 'low',
        status: fallback ? 'accepted' : 'pending',
        reviewStatus: fallback ? 'automatic' : 'needs_review',
        reviewMethod: 'automatic',
        uncertain: !fallback,
        issues: fallback ? [] : ['blank'],
        imageQualityIssues: [],
        alternatives: [],
        reviewEvents: [],
        sbarUpdateEvents: [],
      }
    }

    let editValue = acceptedValue(field)
    let reviewedBlank = field.reviewStatus === 'human_verified' && editValue.trim() === ''
    let hasCapturedValue = Boolean(editValue.trim()) || reviewedBlank
    let uncertain = field.uncertain || field.reviewStatus === 'needs_review'
    return {
      key,
      label: handoverSheetLabels[key],
      value: reviewedBlank ? 'Blank' : editValue.trim() || `${handoverSheetLabels[key]} not captured`,
      editValue,
      hasCapturedValue,
      multiline: multilineColumns.has(key),
      confidence: uncertain ? 'low' : field.reviewStatus === 'llm_adjudicated' ? 'medium' : 'high',
      status: worksheetStatus(field),
      reviewStatus: field.reviewStatus,
      reviewMethod: field.reviewMethod,
      uncertain,
      issues: field.issues,
      imageQualityIssues: field.imageQualityIssues ?? [],
      alternatives: field.alternatives ?? [],
      reviewEvents: field.reviewEvents ?? [],
      sbarUpdateEvents: field.sbarUpdateEvents ?? [],
    }
  })
}

export function parseHandoverSheetCsv(text: string): ParsedHandoverSheetPatient[] {
  let rows = parseDelimitedRows(text)
  if (rows.length < 2) return []
  let mapped = rows[0]!.map((value) => aliases[headerKey(value)])
  if (!mapped.includes('name') && !mapped.includes('bed')) return []
  let patients: ParsedHandoverSheetPatient[] = []
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    let row = rows[rowIndex]!
    let values = new Map<HandoverSheetColumnKey, string>()
    mapped.forEach((column, index) => { if (column) values.set(column, clean(row[index] ?? '')) })
    let displayName = values.get('name') ?? '', location = values.get('bed') ?? ''
    if (!displayName && !location) continue
    patients.push({ displayName: displayName || `Sheet row ${rowIndex + 1}`, location: location || 'Unspecified', fields: handoverSheetColumns.map((column) => field(column, values.get(column) ?? '', 'automatic')), rawText: row.join(' | ') })
  }
  return patients
}

type DocumentCell = z.infer<typeof documentCellSchema>
type DocumentImageIssue = z.infer<typeof documentImageIssueSchema>

function documentImageQualityIssue(issue: DocumentImageIssue): string | null {
  if (issue === 'none') return null
  let messages: Record<Exclude<DocumentImageIssue, 'none'>, string> = {
    blur: 'The document image is blurred.',
    glare: 'Glare may obscure document text.',
    shadow: 'Shadowing may obscure document text.',
    rotation: 'The document image is rotated.',
    perspective: 'Perspective skew may distort document text.',
    low_resolution: 'The document image resolution is low.',
    cropped: 'The document image is cropped and may omit text.',
    not_handover_sheet: 'The expected handover-sheet layout was not detected.',
    unreadable: 'The document image is difficult to read.',
  }
  return messages[issue]
}

function cellImageQualityIssue(issue: DocumentCell['issue']): string | null {
  if (issue === 'none') return null
  let messages: Record<Exclude<DocumentCell['issue'], 'none'>, string> = {
    blur: 'This cell is blurred.',
    cropped: 'This cell is cropped.',
    low_resolution: 'This cell has low-resolution text.',
    ambiguous_characters: 'This cell contains ambiguous characters.',
    unreadable: 'This cell is unreadable.',
  }
  return messages[issue]
}

function modelField(
  column: HandoverSheetColumnKey,
  cell: DocumentCell,
  imageIssue: DocumentImageIssue,
): HandoverSheetPatientField {
  let value = clean(cell.verbatim ?? '')
  let imageQualityIssues = [documentImageQualityIssue(imageIssue), cellImageQualityIssue(cell.issue)]
    .filter((issue): issue is string => Boolean(issue))
  let alternatives = [...new Set(cell.alternatives.map(clean).filter((alternative) => alternative && alternative !== value))].slice(0, 6)
  let issues = new Set<string>()
  if (!value) issues.add('blank')
  if (value) issues.add('native_llm_extracted_value')
  issues.add('native_llm_requires_human_review')
  if (cell.uncertain) issues.add('native_llm_uncertain')
  if (imageIssue !== 'none') issues.add(`native_llm_document_${imageIssue}`)
  if (cell.issue !== 'none') issues.add(`native_llm_cell_${cell.issue}`)
  if (column === 'alerts_allergies' && /allerg|latex|penicillin|sensitivity/i.test(value)) {
    issues.add('clinical_risk_requires_human_review')
  }
  return {
    label: handoverSheetLabels[column],
    columnKey: column,
    value,
    reviewStatus: 'needs_review',
    reviewMethod: 'llm',
    uncertain: true,
    issues: [...issues].slice(0, 12),
    imageQualityIssues,
    alternatives,
    llmAdjudicatedValue: value || null,
    llmUncertain: cell.uncertain,
    llmIssue: cell.issue,
    templateVersion: 'ward-handover-v1',
  }
}

/** Converts the strict OpenAI document response into the canonical persisted JSONB row shape. */
export function parseOpenAIHandoverSheetExtraction(value: unknown): ParsedHandoverSheetPatient[] {
  let parsed = documentExtractionSchema.safeParse(value)
  if (!parsed.success) throw new HandoverSheetExtractionError('Document model returned an invalid extraction.')
  let extraction = parsed.data
  if (!extraction.templateDetected || extraction.imageIssue === 'not_handover_sheet') {
    throw new HandoverSheetExtractionError(
      documentImageQualityIssue(extraction.imageIssue) ?? 'The uploaded document was not recognised as a handover sheet.',
    )
  }
  if (!extraction.extractionComplete || (extraction.omittedRowCount ?? 0) > 0) {
    let omitted = extraction.omittedRowCount && extraction.omittedRowCount > 0
      ? ` ${extraction.omittedRowCount} patient row${extraction.omittedRowCount === 1 ? '' : 's'} may be missing.`
      : ''
    throw new HandoverSheetExtractionError(
      `The document model could not extract the whole handover sheet.${omitted} Retake the photo, upload a clearer scan, or split the sheet and try again.`,
    )
  }
  return extraction.rows.flatMap((row): ParsedHandoverSheetPatient[] => {
    let fields = handoverSheetColumns.map((column) => modelField(column, row.cells[column], extraction.imageIssue))
    let fieldByColumn = new Map(fields.map((candidate) => [candidate.columnKey, candidate]))
    let displayName = clean(fieldByColumn.get('name')?.value ?? '')
    let location = clean(fieldByColumn.get('bed')?.value ?? '')
    if (!displayName && !location) return []
    let fallback = `Sheet row ${row.rowNumber}`
    return [{
      displayName: displayName || fallback,
      location: location || fallback,
      fields,
      rawText: handoverSheetColumns.map((column) => fieldByColumn.get(column)?.value ?? '').join(' | '),
    }]
  })
}

export async function convertHeifToJpeg(bytes: Buffer, options: {
  converter?: (inputPath: string, outputPath: string) => Promise<void>; tempRoot?: string; maxOutputBytes?: number
} = {}): Promise<Buffer> {
  let directory = await mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), 'handover-sheet-heif-'))
  let inputPath = path.join(directory, 'input.heic'), outputPath = path.join(directory, 'output.jpg')
  try {
    await writeFile(inputPath, bytes, { mode: 0o600 })
    let max = options.maxOutputBytes ?? MAX_CONVERTED_IMAGE_BYTES
    if (options.converter) await options.converter(inputPath, outputPath)
    else {
      // Limit the converter's output file at the OS level (ulimit uses
      // 512-byte blocks) so a decompression bomb cannot fill the volume before
      // the post-conversion stat check runs.
      let blocks = Math.max(1, Math.ceil(max / 512))
      await execFileAsync('/bin/sh', [
        '-c', 'ulimit -f "$1"; shift; exec "$@"', 'heif-convert-limit', String(blocks),
        process.env.HEIF_CONVERT_BIN ?? 'heif-convert', inputPath, outputPath,
      ], { timeout: 60_000, maxBuffer: 1024 * 1024 })
    }
    let info = await stat(outputPath)
    if (info.size <= 0 || info.size > max) throw new HandoverSheetExtractionError(`Converted HEIF image exceeds the ${max} byte limit.`)
    let jpeg = await readFile(outputPath)
    if (!(jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[2] === 0xff)) throw new HandoverSheetExtractionError('HEIF converter did not produce a valid JPEG image.')
    return jpeg
  } catch (error) {
    if (error instanceof HandoverSheetExtractionError) throw error
    throw new HandoverSheetExtractionError(`The HEIC/HEIF photo could not be converted: ${error instanceof Error ? error.message : 'conversion failed'}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function extractDocumentWithOpenAI(file: UploadInput): Promise<ParsedHandoverSheetPatient[]> {
  if (!process.env.OPENAI_API_KEY) throw new HandoverSheetExtractionError('OPENAI_API_KEY is required for image or scanned PDF extraction.')
  let client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    maxRetries: 0,
    timeout: Number(process.env.OPENAI_REQUEST_TIMEOUT_MS) || 120_000,
  })
  let isPdf = file.contentType === 'application/pdf'
  let converted = file.contentType === 'image/heic' || file.contentType === 'image/heif'
    ? { ...file, bytes: await convertHeifToJpeg(file.bytes), contentType: 'image/jpeg', filename: `${path.parse(file.filename).name}.jpg` }
    : file
  let document = isPdf
    ? { type: 'input_file' as const, filename: file.filename, file_data: `data:application/pdf;base64,${file.bytes.toString('base64')}` }
    : { type: 'input_image' as const, image_url: `data:${converted.contentType};base64,${converted.bytes.toString('base64')}`, detail: 'original' as const }
  let response
  try {
    response = await client.responses.create({
      model: process.env.OPENAI_MODEL?.trim() || 'gpt-5.5',
      store: false,
      instructions: DOCUMENT_EXTRACTION_INSTRUCTIONS,
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: JSON.stringify({
            task: 'Extract every visible patient row from this handover-sheet document.',
            canonicalColumns: handoverSheetColumns.map((column) => ({ column, label: handoverSheetLabels[column] })),
          }),
        }, document],
      }],
      text: { format: zodTextFormat(documentExtractionSchema, 'handover_sheet_extraction') },
    })
  } catch {
    throw new HandoverSheetExtractionError('The handover sheet could not be digitised by the document model.')
  }
  if (!response.output_text) throw new HandoverSheetExtractionError('Document model returned no extracted text.')
  let decoded: unknown
  try { decoded = JSON.parse(response.output_text) }
  catch { throw new HandoverSheetExtractionError('Document model returned an invalid extraction.') }
  return parseOpenAIHandoverSheetExtraction(decoded)
}

async function uploadInput(file: UploadInput | File): Promise<UploadInput> {
  if (Buffer.isBuffer((file as UploadInput).bytes)) return file as UploadInput
  let webFile = file as File
  return {
    bytes: Buffer.from(await webFile.arrayBuffer()),
    contentType: webFile.type || 'application/octet-stream',
    filename: webFile.name || 'handover-sheet.bin',
  }
}

export async function extractHandoverSheet(file: UploadInput | File): Promise<HandoverSheetExtraction> {
  let value = validateUpload(await uploadInput(file), sheetUploadPolicy)
  let textual = value.contentType.startsWith('text/')
  let patients = textual ? parseHandoverSheetCsv(value.bytes.toString('utf8')) : await extractDocumentWithOpenAI(value)
  if (!patients.length) throw new HandoverSheetExtractionError('No patient rows were found in the uploaded handover sheet.')
  return {
    fileName: value.filename,
    contentType: value.contentType,
    sourceFileSizeBytes: value.bytes.length,
    method: textual ? 'text' : value.contentType === 'application/pdf' ? 'pdf-llm' : 'image-llm',
    patients,
  }
}
