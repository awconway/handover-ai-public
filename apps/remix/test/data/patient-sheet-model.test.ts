import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import {
  buildPatientWorksheetFields,
  handoverSheetColumns,
  handoverSheetLabels,
  patientWorksheetFieldsFromAnalysis,
} from '../../app/data/handover-sheet.ts'

describe('patient handover-sheet model', () => {
  it('always projects stored rows into the canonical eleven-field contract', () => {
    let fields = buildPatientWorksheetFields([
      {
        label: 'Problem',
        value: 'Seps1s',
        reviewStatus: 'needs_review',
        reviewMethod: 'llm',
        uncertain: true,
        alternatives: ['Sepsis', '', 'Septic illness', 'ignored fourth option'],
      },
      { label: 'Patient name', value: 'Molly Harper', reviewStatus: 'automatic' },
      { label: 'Location', value: '3A-01', reviewStatus: 'automatic' },
      { label: 'Planning', value: 'Home with community review.', reviewStatus: 'automatic' },
    ], { displayName: 'Fallback patient', location: 'Fallback bed' })

    assert.equal(fields.length, 11)
    assert.deepEqual(fields.map((field) => field.key), [...handoverSheetColumns])
    assert.deepEqual(fields.map((field) => field.label), handoverSheetColumns.map((key) => handoverSheetLabels[key]))
    assert.equal(fields[0]!.value, '3A-01')
    assert.equal(fields[0]!.status, 'accepted')
    assert.equal(fields[1]!.value, 'Molly Harper')
    assert.equal(fields[1]!.status, 'accepted')
    assert.equal(fields[4]!.value, 'Seps1s')
    assert.equal(fields[4]!.confidence, 'low')
    assert.equal(fields[4]!.status, 'pending')
    assert.deepEqual(fields[4]!.alternatives, ['Sepsis', 'Septic illness', 'ignored fourth option'])
    assert.equal(fields.find((field) => field.key === 'background')?.multiline, true)
    assert.equal(fields.find((field) => field.key === 'assessment_management')?.multiline, true)
    assert.equal(fields.find((field) => field.key === 'planning')?.multiline, true)
    assert.equal(fields.find((field) => field.key === 'diagnosis')?.multiline, false)
    assert.equal(fields.find((field) => field.key === 'diet')?.value, 'Diet not captured')
  })

  it('preserves reviewed blanks and sanitized review and SBAR provenance', () => {
    let fields = buildPatientWorksheetFields([{
      columnKey: 'diagnosis',
      label: 'Diagnosis',
      value: 'Seps1s',
      finalAcceptedValue: '',
      humanReviewedValue: '',
      reviewStatus: 'human_verified',
      reviewMethod: 'human',
      reviewDecision: 'rejected',
      reviewEvents: [{
        at: '2026-07-13T01:00:00.000Z',
        byUserId: 'user-1',
        previousValue: 'Seps1s',
        nextValue: '',
        method: 'human',
      }],
      sbarUpdateEvents: [{
        at: '2026-07-13T00:55:00.000Z',
        handoverId: 'handover-1',
        handoverTitle: 'Ward update',
        sbarSection: 'assessment',
        previousValue: 'Sepsis',
        nextValue: 'Seps1s',
        summaryQuote: 'Possible transcription uncertainty.',
        rationale: 'The latest assessment changed the diagnosis.',
      }],
    }], { displayName: 'Molly Harper', location: '3A-01' })

    let diagnosis = fields.find((field) => field.key === 'diagnosis')!
    assert.equal(diagnosis.value, 'Blank')
    assert.equal(diagnosis.editValue, '')
    assert.equal(diagnosis.hasCapturedValue, true)
    assert.equal(diagnosis.status, 'rejected')
    assert.equal(diagnosis.reviewEvents.length, 1)
    assert.equal(diagnosis.sbarUpdateEvents[0]?.handoverId, 'handover-1')
  })

  it('uses patient identity only when the imported row omitted Bed or Name', () => {
    let omitted = buildPatientWorksheetFields([], { displayName: 'Molly Harper', location: '3A-01' })
    assert.equal(omitted[0]!.value, '3A-01')
    assert.equal(omitted[1]!.value, 'Molly Harper')

    let capturedBlank = buildPatientWorksheetFields([
      { columnKey: 'bed', label: 'Bed', value: '', reviewStatus: 'needs_review' },
      { columnKey: 'name', label: 'Name', value: '', reviewStatus: 'needs_review' },
    ], { displayName: 'Molly Harper', location: '3A-01' })
    assert.equal(capturedBlank[0]!.value, 'Bed not captured')
    assert.equal(capturedBlank[1]!.value, 'Name not captured')
  })

  it('reads manual worksheet reviews from handover analysis', () => {
    let fields = patientWorksheetFieldsFromAnalysis({
      patientWorksheetFields: {
        'patient-1': [{
          columnKey: 'diagnosis',
          label: 'Diagnosis',
          value: '',
          finalAcceptedValue: 'Community-acquired pneumonia',
          reviewStatus: 'human_verified',
          reviewMethod: 'human',
          uncertain: false,
          issues: [],
        }],
      },
    }, 'patient-1')

    assert.equal(fields.length, 1)
    assert.equal(fields[0]?.columnKey, 'diagnosis')
    assert.equal(fields[0]?.finalAcceptedValue, 'Community-acquired pneumonia')
    assert.deepEqual(patientWorksheetFieldsFromAnalysis({}, 'patient-1'), [])
  })

  it('reads a uniquely attributable placeholder review through the derived workspace key', () => {
    let fields = patientWorksheetFieldsFromAnalysis({
      patients: [{
        patientKey: 'not-provided',
        displayName: 'Arthur Dent',
        location: 'Bed 4',
      }],
      patientWorksheetFields: {
        'not-provided': [{
          columnKey: 'diagnosis',
          label: 'Diagnosis',
          value: 'Pneumonia',
          reviewStatus: 'human_verified',
        }],
      },
    }, 'arthur-dent-bed-4')

    assert.equal(fields.length, 1)
    assert.equal(fields[0]?.columnKey, 'diagnosis')
    assert.equal(fields[0]?.value, 'Pneumonia')
  })

  it('does not share one placeholder review between distinct patients', () => {
    let fields = patientWorksheetFieldsFromAnalysis({
      patients: [{
        patientKey: 'not-provided',
        displayName: 'Arthur Dent',
        location: 'Bed 4',
      }, {
        patientKey: 'not-provided',
        displayName: 'Ford Prefect',
        location: 'Bed 5',
      }],
      patientWorksheetFields: {
        'not-provided': [{
          columnKey: 'diagnosis',
          label: 'Diagnosis',
          value: 'Ambiguous legacy review',
          reviewStatus: 'human_verified',
        }],
      },
    }, 'arthur-dent-bed-4')

    assert.deepEqual(fields, [])
  })
})
