import * as assert from 'remix/assert'
import type { Database } from 'remix/data-table'
import { describe, it } from 'remix/test'

import type { HandoverSheetPatientField } from '../../app/data/handover-sheet.ts'
import {
  applyHandoverSheetSbarChanges,
  listStoredHandoverSheetReconciliationTargets,
  mergeReviewedHandoverSheetFields,
} from '../../app/data/repository.ts'

const at = '2026-07-13T02:00:00.000Z'

function reviewedDiagnosis(finalAcceptedValue = 'Pneumonia'): HandoverSheetPatientField {
  return {
    label: 'Diagnosis',
    columnKey: 'diagnosis',
    value: 'Pneumonia?',
    humanReviewedValue: finalAcceptedValue,
    finalAcceptedValue,
    reviewStatus: 'human_verified',
    reviewMethod: 'human',
    reviewDecision: 'edited',
    uncertain: false,
    issues: [],
    reviewedAt: '2026-07-13T01:00:00.000Z',
    reviewedByUserId: 'user-1',
    reviewEvents: [{
      at: '2026-07-13T01:00:00.000Z',
      byUserId: 'user-1',
      previousValue: 'Pneumonia?',
      nextValue: finalAcceptedValue,
      method: 'human',
    }],
  }
}

const change = {
  columnKey: 'diagnosis' as const,
  nextValue: 'Pneumonia with new oxygen requirement.',
  sbarSection: 'assessment' as const,
  summaryQuote: 'New oxygen requirement',
  rationale: 'The current assessment adds a clinically useful change.',
}

describe('handover-sheet reconciliation persistence model', () => {
  it('builds source-linked targets only for an unambiguous canonical patient row', async () => {
    let handover = {
      id: 'handover-1',
      title: 'Ward update',
      context_type: 'shift-handover',
      shift_id: 'shift-1',
      source_shift_id: null,
      linked_patient_key: 'molly-harper',
      linked_patient_display_name: 'Molly Harper',
      linked_patient_location: '3A-01',
      participants: [],
      shared_with_user_ids: [],
      transcription_metadata: null,
      processing_status: 'completed',
      version: 3,
      analysis: {
        titleSuggestion: 'Current ward update',
        structuredSummary: {
          situation: 'Molly remains stable.',
          background: 'Admitted with pneumonia.',
          assessment: 'New oxygen requirement.',
          recommendation: 'Repeat observations.',
        },
        sbarEvidence: [{ label: 'ASSESSMENT', quote: 'New oxygen requirement' }],
        patients: [{ patientKey: 'molly-harper', displayName: 'Molly Harper', location: '3A-01' }],
      },
    }
    let rows = [{
      id: 'sheet-patient-1',
      shift_id: 'shift-1',
      patient_key: 'molly-harper',
      display_name: 'Molly Harper',
      location: '3A-01',
      fields: [reviewedDiagnosis()],
      row_index: 0,
    }]
    let db = {
      async find() { return handover },
      async findMany() { return rows },
    } as unknown as Database

    let targets = await listStoredHandoverSheetReconciliationTargets(db, 'handover-1')
    assert.equal(targets.length, 1)
    assert.equal(targets[0]!.sheetPatientId, 'sheet-patient-1')
    assert.equal(targets[0]!.handoverVersion, 3)
    assert.equal(targets[0]!.handoverTitle, 'Ward update')
    assert.equal(targets[0]!.expectedValues.diagnosis, 'Pneumonia')
    assert.equal(targets[0]!.sbarEvidence?.[0]?.quote, 'New oxygen requirement')

    handover.linked_patient_key = 'unmatched-key'
    handover.linked_patient_location = ''
    rows.push({ ...rows[0]!, id: 'sheet-patient-2', patient_key: 'other-molly', location: '3A-02' })
    assert.equal((await listStoredHandoverSheetReconciliationTargets(db, 'handover-1')).length, 0)
  })

  it('preserves the manual value and audit history while recording a reviewable SBAR update', () => {
    let result = applyHandoverSheetSbarChanges({
      fields: [reviewedDiagnosis()],
      displayName: 'Molly Harper',
      location: '3A-01',
      expectedValues: { diagnosis: 'Pneumonia' },
      changes: [change],
      at,
      handoverId: 'handover-1',
      handoverTitle: 'Ward update',
    })
    assert.deepEqual(result.changedColumns, ['diagnosis'])
    let diagnosis = result.fields[0]!
    assert.equal(diagnosis.humanReviewedValue, 'Pneumonia')
    assert.equal(diagnosis.finalAcceptedValue, change.nextValue)
    assert.equal(diagnosis.reviewStatus, 'needs_review')
    assert.equal(diagnosis.reviewMethod, 'llm')
    assert.equal(diagnosis.reviewDecision, undefined)
    assert.equal(diagnosis.reviewEvents?.length, 2)
    assert.equal(diagnosis.reviewEvents?.[0]?.method, 'human')
    assert.equal(diagnosis.reviewEvents?.[1]?.method, 'llm')
    assert.equal(diagnosis.sbarUpdateEvents?.[0]?.handoverId, 'handover-1')
    assert.equal(diagnosis.sbarUpdateEvents?.[0]?.summaryQuote, 'New oxygen requirement')
    assert.ok(diagnosis.issues.includes('sbar_reconciliation_requires_human_review'))
  })

  it('skips a stale proposal when a clinician changed that field after the model prompt', () => {
    let result = applyHandoverSheetSbarChanges({
      fields: [reviewedDiagnosis('Clinician changed this after the prompt')],
      displayName: 'Molly Harper',
      location: '3A-01',
      expectedValues: { diagnosis: 'Pneumonia' },
      changes: [change],
      at,
      handoverId: 'handover-1',
      handoverTitle: 'Ward update',
    })
    assert.deepEqual(result.changedColumns, [])
    assert.equal(result.fields[0]!.finalAcceptedValue, 'Clinician changed this after the prompt')
    assert.equal(result.fields[0]!.sbarUpdateEvents?.length ?? 0, 0)
  })

  it('does not record the same handover update twice', () => {
    let first = applyHandoverSheetSbarChanges({
      fields: [reviewedDiagnosis()],
      displayName: 'Molly Harper',
      location: '3A-01',
      expectedValues: { diagnosis: 'Pneumonia' },
      changes: [change],
      at,
      handoverId: 'handover-1',
      handoverTitle: 'Ward update',
    })
    let second = applyHandoverSheetSbarChanges({
      fields: first.fields,
      displayName: first.displayName,
      location: first.location,
      expectedValues: { diagnosis: change.nextValue },
      changes: [change],
      at,
      handoverId: 'handover-1',
      handoverTitle: 'Ward update',
    })
    assert.deepEqual(second.changedColumns, [])
    assert.equal(second.fields[0]!.sbarUpdateEvents?.length, 1)
  })

  it('retains accepted values and full provenance when the source sheet is imported again', () => {
    let reconciled = applyHandoverSheetSbarChanges({
      fields: [reviewedDiagnosis()],
      displayName: 'Molly Harper',
      location: '3A-01',
      expectedValues: { diagnosis: 'Pneumonia' },
      changes: [change],
      at,
      handoverId: 'handover-1',
      handoverTitle: 'Ward update',
    }).fields
    let reimported = mergeReviewedHandoverSheetFields([{
      label: 'Diagnosis',
      columnKey: 'diagnosis',
      value: 'Fresh OCR value',
      reviewStatus: 'needs_review',
      reviewMethod: 'llm',
      uncertain: true,
      issues: ['native_llm_requires_human_review'],
      alternatives: ['Fresh OCR alternative'],
    }], reconciled)
    let diagnosis = reimported[0]!
    assert.equal(diagnosis.value, change.nextValue)
    assert.equal(diagnosis.humanReviewedValue, 'Pneumonia')
    assert.equal(diagnosis.finalAcceptedValue, change.nextValue)
    assert.equal(diagnosis.reviewEvents?.length, 2)
    assert.equal(diagnosis.sbarUpdateEvents?.length, 1)
    assert.ok(diagnosis.issues.includes('native_llm_requires_human_review'))
    assert.ok(diagnosis.issues.includes('sbar_reconciliation_requires_human_review'))
    assert.deepEqual(diagnosis.alternatives, ['Fresh OCR alternative'])
  })
})
