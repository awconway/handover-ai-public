import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import {
  buildShiftWorkspaceReadModel,
  handoverSubtitle,
  isHandoverRelatedToShift,
  resolveShiftScopedHandoverDirection,
} from '../../app/data/workspace-read-model.ts'
import type { HandoverPatientRow, HandoverRow, HandoverTaskRow, ShiftRow, ShiftSheetPatientRow } from '../../app/data/schema.ts'

describe('workspace read model parity', () => {
  it('uses the authoritative source relation and resolves placed outgoing direction per shift', () => {
    let placed = handover({
      id: 'placed', shift_id: 'target', source_shift_id: 'source', source_handover_id: null,
      direction: 'outgoing', processing_status: 'completed',
    })
    let copy = handover({ id: 'copy', shift_id: 'target', source_shift_id: 'source', source_handover_id: 'placed' })

    assert.equal(isHandoverRelatedToShift(placed, 'source'), true)
    assert.equal(isHandoverRelatedToShift(copy, 'source'), false)
    assert.equal(resolveShiftScopedHandoverDirection(placed, 'source'), 'outgoing')
    assert.equal(resolveShiftScopedHandoverDirection(placed, 'target'), 'incoming')
  })

  it('excludes failed rows without projections while retaining failed reviewable data', () => {
    let failedEmpty = handover({ id: 'failed-empty', processing_status: 'failed' })
    let failedProjected = handover({ id: 'failed-projected', processing_status: 'failed' })
    let model = buildShiftWorkspaceReadModel({
      shift: shift(),
      handovers: [failedEmpty, failedProjected],
      sheetPatients: [],
      handoverPatients: [patient({ handover_id: 'failed-projected', patient_key: 'patient-a' })],
      tasks: [task({ handover_id: 'failed-empty' }), task({ id: 'task-2', handover_id: 'failed-projected' })],
    })

    assert.deepEqual(model.handovers.map((item) => item.row.id), ['failed-projected'])
    assert.equal(model.handoverCount, 1)
    assert.equal(model.patientCount, 1)
    assert.equal(model.openTaskCount, 1)
  })

  it('keeps active linked patients separate from available counts and honours explicit then recency order', () => {
    let model = buildShiftWorkspaceReadModel({
      shift: shift({ patient_order: ['patient-b'] }),
      handovers: [
        handover({ id: 'active', linked_patient_key: 'Patient C', linked_patient_display_name: 'Patient C', processing_status: 'analysing', analysis: { patients: [{ displayName: 'Patient C', location: 'Bed 3' }] }, updated_at: date(30) }),
        handover({ id: 'available-a', processing_status: 'completed', updated_at: date(20) }),
        handover({ id: 'available-b', processing_status: 'completed', updated_at: date(10) }),
      ],
      sheetPatients: [],
      handoverPatients: [
        patient({ id: 'pa', handover_id: 'available-a', patient_key: 'patient-a', created_at: date(20) }),
        patient({ id: 'pb', handover_id: 'available-b', patient_key: 'patient-b', created_at: date(10) }),
      ],
      tasks: [],
    })

    assert.deepEqual(model.patients.map((item) => item.key), ['patient-b', 'patient-c', 'patient-a'])
    assert.equal(model.handoverCount, 2)
    assert.equal(model.patientCount, 3)
    assert.equal(model.handovers.find((item) => item.row.id === 'active')?.patientCount, 1)
    assert.equal(model.patients.find((item) => item.key === 'patient-c')?.processingHandovers.length, 1)
  })

  it('reconciles legacy placeholder clinical keys to sheet patients without creating a phantom patient', () => {
    let model = buildShiftWorkspaceReadModel({
      shift: shift({ patient_order: ['arthur-dent-bed-4', 'mary-lee-bed-5', 'sam-patel-bed-6'] }),
      handovers: [handover({
        analysis: {
          patients: [
            { patientKey: 'not-provided', displayName: 'Arthur Dent', location: 'Bed 4' },
            { patientKey: 'not-provided', displayName: 'Mary Lee', location: 'Bed 5' },
            { patientKey: 'not-provided', displayName: 'Sam Patel', location: 'Bed 6' },
          ],
        },
      })],
      sheetPatients: [
        sheetPatient({ id: 'sheet-arthur', patient_key: 'arthur-dent-bed-4', display_name: 'Arthur Dent', location: 'Bed 4', row_index: 0 }),
        sheetPatient({ id: 'sheet-mary', patient_key: 'mary-lee-bed-5', display_name: 'Mary Lee', location: 'Bed 5', row_index: 1 }),
        sheetPatient({ id: 'sheet-sam', patient_key: 'sam-patel-bed-6', display_name: 'Sam Patel', location: 'Bed 6', row_index: 2 }),
      ],
      handoverPatients: [
        patient({ id: 'clinical-arthur', patient_key: 'not-provided', display_name: 'Arthur Dent', location: 'Bed 4' }),
        patient({ id: 'clinical-mary', patient_key: 'not-provided', display_name: 'Mary Lee', location: 'Bed 5' }),
        patient({ id: 'clinical-sam', patient_key: 'not-provided', display_name: 'Sam Patel', location: 'Bed 6' }),
        patient({ id: 'clinical-phantom', patient_key: 'not-provided', display_name: 'Not provided', location: 'Not provided' }),
      ],
      tasks: [],
    })

    assert.deepEqual(model.patients.map((item) => item.key), [
      'arthur-dent-bed-4',
      'mary-lee-bed-5',
      'sam-patel-bed-6',
    ])
    assert.deepEqual(
      model.patients.map((item) => item.clinicalRows.map((row) => row.id)),
      [['clinical-arthur'], ['clinical-mary'], ['clinical-sam']],
    )
    assert.equal(model.handovers[0]?.patientCount, 3)
  })

  it('reconciles distinct legacy placeholder tasks by persisted analysis task ID and canonical identity', () => {
    let model = buildShiftWorkspaceReadModel({
      shift: shift(),
      handovers: [handover({
        analysis: {
          patients: [
            {
              patientKey: 'not-provided',
              displayName: 'Alex Lee',
              location: 'Bed 1',
              tasks: [{ id: 'task-bed-1', title: 'Review oxygen target' }],
            },
            {
              patientKey: 'not-provided',
              displayName: 'Alex Lee',
              location: 'Bed 2',
              tasks: [{ id: 'task-bed-2', title: 'Repeat blood pressure' }],
            },
          ],
        },
      })],
      sheetPatients: [
        sheetPatient({ id: 'sheet-bed-1', patient_key: 'alex-lee-bed-1', display_name: 'Alex Lee', location: 'Bed 1', row_index: 0 }),
        sheetPatient({ id: 'sheet-bed-2', patient_key: 'alex-lee-bed-2', display_name: 'Alex Lee', location: 'Bed 2', row_index: 1 }),
      ],
      handoverPatients: [
        patient({ id: 'clinical-bed-1', patient_key: 'not-provided', display_name: 'Alex Lee', location: 'Bed 1' }),
        patient({ id: 'clinical-bed-2', patient_key: 'not-provided', display_name: 'Alex Lee', location: 'Bed 2' }),
      ],
      tasks: [
        task({ id: 'task-bed-1', patient_key: 'not-provided', title: 'Review oxygen target', status: 'open' }),
        task({ id: 'task-bed-2', patient_key: 'not-provided', title: 'Repeat blood pressure', status: 'done' }),
      ],
    })

    let bed1 = model.patients.find((item) => item.key === 'alex-lee-bed-1')
    let bed2 = model.patients.find((item) => item.key === 'alex-lee-bed-2')
    assert.deepEqual(bed1?.taskIds, ['task-bed-1'])
    assert.deepEqual(bed2?.taskIds, ['task-bed-2'])
    assert.equal(bed1?.openTaskCount, 1)
    assert.equal(bed2?.openTaskCount, 0)
  })

  it('preserves meaningful no-sheet placeholder patients with their handovers and tasks', () => {
    let model = buildShiftWorkspaceReadModel({
      shift: shift(),
      handovers: [handover({
        analysis: {
          patients: [
            {
              patientKey: 'not-provided',
              displayName: 'Arthur Dent',
              location: 'Bed 4',
              tasks: [{ id: 'task-arthur', title: 'Review oxygen target' }],
            },
            {
              patientKey: 'not-provided',
              displayName: 'Not provided',
              location: 'Bed 9',
            },
            {
              patientKey: 'not-provided',
              displayName: 'Not provided',
              location: 'Not provided',
            },
          ],
        },
      })],
      sheetPatients: [],
      handoverPatients: [
        patient({ id: 'clinical-arthur', patient_key: 'not-provided', display_name: 'Arthur Dent', location: 'Bed 4' }),
        patient({ id: 'clinical-bed-9', patient_key: 'not-provided', display_name: 'Not provided', location: 'Bed 9' }),
        patient({ id: 'clinical-anonymous', patient_key: 'not-provided', display_name: 'Not provided', location: 'Not provided' }),
      ],
      tasks: [
        task({ id: 'task-arthur', patient_key: 'not-provided', title: 'Review oxygen target', status: 'open' }),
      ],
    })

    assert.deepEqual(model.patients.map((item) => item.key), ['arthur-dent-bed-4', 'bed-9'])
    let arthur = model.patients.find((item) => item.key === 'arthur-dent-bed-4')
    assert.deepEqual(arthur?.clinicalRows.map((row) => row.id), ['clinical-arthur'])
    assert.deepEqual(arthur?.handovers.map((item) => item.row.id), ['handover'])
    assert.deepEqual(arthur?.taskIds, ['task-arthur'])
    assert.equal(arthur?.openTaskCount, 1)
    assert.deepEqual(
      model.patients.find((item) => item.key === 'bed-9')?.clinicalRows.map((row) => row.id),
      ['clinical-bed-9'],
    )
    assert.equal(model.handovers[0]?.patientCount, 2)
  })

  it('preserves a meaningful no-sheet placeholder patient while processing', () => {
    let model = buildShiftWorkspaceReadModel({
      shift: shift(),
      handovers: [handover({
        id: 'processing',
        processing_status: 'analysing',
        linked_patient_key: 'not-provided',
        linked_patient_display_name: 'Trillian Astra',
        linked_patient_location: 'Bay 2',
        analysis: {
          patients: [{ patientKey: 'not-provided', displayName: 'Trillian Astra', location: 'Bay 2' }],
        },
      })],
      sheetPatients: [],
      handoverPatients: [],
      tasks: [],
    })

    assert.equal(model.patientCount, 1)
    assert.equal(model.patients[0]?.key, 'trillian-astra-bay-2')
    assert.deepEqual(model.patients[0]?.processingHandovers.map((item) => item.row.id), ['processing'])
    assert.equal(model.handovers[0]?.patientCount, 1)
  })

  it('attaches a manual placeholder task when its handover has exactly one patient', () => {
    let model = buildShiftWorkspaceReadModel({
      shift: shift(),
      handovers: [handover({
        analysis: {
          patients: [{ patientKey: 'not-provided', displayName: 'Arthur Dent', location: 'Bed 4' }],
        },
      })],
      sheetPatients: [],
      handoverPatients: [
        patient({ id: 'clinical-arthur', patient_key: 'not-provided', display_name: 'Arthur Dent', location: 'Bed 4' }),
      ],
      tasks: [
        task({ id: 'manual-task', patient_key: 'not-provided', title: 'Call respiratory registrar' }),
      ],
    })

    assert.deepEqual(model.patients[0]?.taskIds, ['manual-task'])
    assert.equal(model.patients[0]?.openTaskCount, 1)
  })

  it('leaves a manual placeholder task unassigned when its handover has multiple patients', () => {
    let model = buildShiftWorkspaceReadModel({
      shift: shift(),
      handovers: [handover({
        analysis: {
          patients: [
            { patientKey: 'not-provided', displayName: 'Arthur Dent', location: 'Bed 4' },
            { patientKey: 'not-provided', displayName: 'Ford Prefect', location: 'Bed 5' },
          ],
        },
      })],
      sheetPatients: [],
      handoverPatients: [
        patient({ id: 'clinical-arthur', patient_key: 'not-provided', display_name: 'Arthur Dent', location: 'Bed 4' }),
        patient({ id: 'clinical-ford', patient_key: 'not-provided', display_name: 'Ford Prefect', location: 'Bed 5' }),
      ],
      tasks: [
        task({ id: 'manual-task', patient_key: 'not-provided', title: 'Call respiratory registrar' }),
      ],
    })

    assert.deepEqual(model.patients.map((item) => item.taskIds), [[], []])
    assert.deepEqual(model.patients.map((item) => item.openTaskCount), [0, 0])
    assert.equal(model.openTaskCount, 1)
  })

  it('keeps same-name no-sheet patients separate when one location is missing regardless of row order', () => {
    let rows = [
      patient({ id: 'clinical-missing', patient_key: 'not-provided', display_name: 'Alex Lee', location: '' }),
      patient({ id: 'clinical-bed-2', patient_key: 'not-provided', display_name: 'Alex Lee', location: 'Bed 2' }),
    ]

    for (let handoverPatients of [rows, rows.toReversed()]) {
      let model = buildShiftWorkspaceReadModel({
        shift: shift(),
        handovers: [handover({
          analysis: {
            patients: [
              { patientKey: 'not-provided', displayName: 'Alex Lee', location: '' },
              { patientKey: 'not-provided', displayName: 'Alex Lee', location: 'Bed 2' },
            ],
          },
        })],
        sheetPatients: [],
        handoverPatients,
        tasks: [],
      })

      assert.deepEqual(model.patients.map((item) => item.key).toSorted(), ['alex-lee', 'alex-lee-bed-2'])
      assert.deepEqual(
        model.patients.flatMap((item) => item.clinicalRows.map((row) => row.id)).toSorted(),
        ['clinical-bed-2', 'clinical-missing'],
      )
    }
  })

  it('does not merge a location-less legacy patient into a same-name sheet patient', () => {
    let model = buildShiftWorkspaceReadModel({
      shift: shift({ patient_order: ['alex-lee-bed-2'] }),
      handovers: [handover({
        analysis: {
          patients: [
            {
              patientKey: 'not-provided',
              displayName: 'Alex Lee',
              location: '',
              tasks: [{ id: 'task-missing', title: 'Clarify bed allocation' }],
            },
            {
              patientKey: 'not-provided',
              displayName: 'Alex Lee',
              location: 'Bed 2',
              tasks: [{ id: 'task-bed-2', title: 'Repeat blood pressure' }],
            },
          ],
        },
      })],
      sheetPatients: [
        sheetPatient({
          id: 'sheet-bed-2',
          patient_key: 'alex-lee-bed-2',
          display_name: 'Alex Lee',
          location: 'Bed 2',
          row_index: 0,
        }),
      ],
      handoverPatients: [
        patient({
          id: 'clinical-missing',
          patient_key: 'not-provided',
          display_name: 'Alex Lee',
          location: '',
        }),
        patient({
          id: 'clinical-bed-2',
          patient_key: 'not-provided',
          display_name: 'Alex Lee',
          location: 'Bed 2',
        }),
      ],
      tasks: [
        task({ id: 'task-missing', patient_key: 'not-provided', title: 'Clarify bed allocation' }),
        task({ id: 'task-bed-2', patient_key: 'not-provided', title: 'Repeat blood pressure' }),
      ],
    })

    assert.deepEqual(model.patients.map((item) => item.key).toSorted(), ['alex-lee', 'alex-lee-bed-2'])
    assert.deepEqual(
      model.patients.find((item) => item.key === 'alex-lee')?.taskIds,
      ['task-missing'],
    )
    assert.deepEqual(
      model.patients.find((item) => item.key === 'alex-lee-bed-2')?.taskIds,
      ['task-bed-2'],
    )
    assert.equal(model.handovers[0]?.patientCount, 2)
  })

  it('prefers patient previews, notes, and overview before a completed handover fallback', () => {
    assert.equal(handoverSubtitle(handover({ analysis: { patients: [
      { displayName: 'A', location: 'Bed 1' },
      { displayName: 'B', location: '' },
      { displayName: 'C', location: 'Bed 3' },
    ] } })), 'A · Bed 1, B +1 more')
    assert.equal(handoverSubtitle(handover({ notes: 'Clinician note', analysis: { overview: 'Overview', patients: [] } })), 'Clinician note')
    assert.equal(handoverSubtitle(handover({ analysis: { overview: 'Overview', patients: [] } })), 'Overview')
    assert.equal(handoverSubtitle(handover({ analysis: { analysisReadiness: { patients: false }, patients: [{ displayName: 'Hidden' }] } })), 'Ready for review')
  })

  it('only describes completed handovers as ready when no preview is available', () => {
    assert.equal(handoverSubtitle(handover({ processing_status: 'failed' })), 'Open the handover to retry or inspect details.')
    assert.match(handoverSubtitle(handover({ processing_status: 'queued' })), /Queued for transcription and analysis/)
    assert.match(handoverSubtitle(handover({ processing_status: 'transcribing' })), /Transcribing the handover/)
    assert.match(handoverSubtitle(handover({ processing_status: 'analysing' })), /Extracting the summary/)
    assert.equal(handoverSubtitle(handover()), 'Ready for review')
  })

  it('preserves retained patient previews, notes, and overview after processing fails', () => {
    assert.equal(handoverSubtitle(handover({ processing_status: 'failed', analysis: { patients: [
      { displayName: 'Patient A', location: 'Bed 1' },
    ] } })), 'Patient A · Bed 1')
    assert.equal(handoverSubtitle(handover({ processing_status: 'failed', notes: 'Clinician note' })), 'Clinician note')
    assert.equal(handoverSubtitle(handover({ processing_status: 'failed', analysis: { overview: 'Previous overview' } })), 'Previous overview')
  })
})

function date(seconds: number) { return new Date(`2026-07-14T00:00:${String(seconds).padStart(2, '0')}.000Z`) }

function shift(overrides: Record<string, unknown> = {}) {
  return { id: 'shift', title: 'Day shift', department: 'Medicine', notes: '', patient_order: [], created_at: date(0), updated_at: date(0), ...overrides } as unknown as ShiftRow
}

function handover(overrides: Record<string, unknown> = {}) {
  return {
    id: 'handover', shift_id: 'shift', source_shift_id: null, source_handover_id: null,
    title: 'Handover', notes: '', direction: 'incoming', processing_status: 'completed',
    linked_patient_key: null, linked_patient_display_name: null, linked_patient_location: null,
    analysis: null, created_at: date(0), updated_at: date(0),
    ...overrides,
  } as unknown as HandoverRow
}

function patient(overrides: Record<string, unknown> = {}) {
  return {
    id: 'patient', handover_id: 'handover', patient_key: 'patient', display_name: 'Patient', location: '',
    acuity_score: 0, risk_score: 0, workflow_score: 0, created_at: date(0), ...overrides,
  } as unknown as HandoverPatientRow
}

function task(overrides: Record<string, unknown> = {}) {
  return { id: 'task', handover_id: 'handover', patient_key: 'patient', status: 'open', ...overrides } as unknown as HandoverTaskRow
}

function sheetPatient(overrides: Record<string, unknown> = {}) {
  return { id: 'sheet', shift_id: 'shift', patient_key: 'patient', row_index: 0, updated_at: date(0), ...overrides } as unknown as ShiftSheetPatientRow
}

void sheetPatient
