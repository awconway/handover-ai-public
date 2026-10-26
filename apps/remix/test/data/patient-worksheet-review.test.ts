import * as assert from 'remix/assert'
import type { Database, SqlStatement } from 'remix/data-table'
import { describe, it } from 'remix/test'

import { reviewShiftSheetPatientField } from '../../app/data/repository.ts'

class WorksheetReviewDatabase {
  analysis: Record<string, unknown>
  linkedPatientKey: string
  clinicalPatients: Array<{
    id: string
    handover_id: string
    patient_key: string
    display_name: string
    location: string
  }>

  constructor(legacy = false, sibling = legacy, priorAliasFields = false) {
    this.linkedPatientKey = legacy ? 'not-provided' : 'patient-1'
    this.analysis = {
      headline: 'Existing analysis',
      patients: [
        { patientKey: this.linkedPatientKey, displayName: 'Molly Harper', location: '3A-01' },
        ...(sibling
          ? [{ patientKey: this.linkedPatientKey, displayName: 'Ford Prefect', location: '3A-02' }]
          : []),
      ],
      ...(priorAliasFields ? {
        patientWorksheetFields: {
          'not-provided': [
            worksheetField('alerts_allergies', 'Legacy allergy review'),
            worksheetField('diagnosis', 'Legacy diagnosis'),
          ],
          'molly-harper-3a-01': [
            worksheetField('diagnosis', 'Current diagnosis'),
          ],
        },
      } : {}),
    }
    this.clinicalPatients = [
      {
        id: 'clinical-1',
        handover_id: 'handover-1',
        patient_key: this.linkedPatientKey,
        display_name: 'Molly Harper',
        location: '3A-01',
      },
      ...(sibling ? [{
        id: 'clinical-2',
        handover_id: 'handover-1',
        patient_key: this.linkedPatientKey,
        display_name: 'Ford Prefect',
        location: '3A-02',
      }] : []),
    ]
  }

  async transaction<T>(callback: (db: Database) => Promise<T>): Promise<T> {
    return callback(this as unknown as Database)
  }

  async exec(statement: SqlStatement) {
    if (/select \* from shifts where id/.test(statement.text)) {
      return { rows: [{
        id: 'shift-1', created_by_user_id: 'user-1', assigned_user_ids: ['user-1'],
        patient_order: ['patient-1'],
      }] }
    }
    if (/select \* from shift_sheet_patients/.test(statement.text)) return { rows: [] }
    if (/select h\.id, h\.analysis/.test(statement.text)) {
      return { rows: [{
        id: 'handover-1',
        analysis: structuredClone(this.analysis),
        linked_patient_key: this.linkedPatientKey,
        linked_patient_display_name: 'Molly Harper',
        linked_patient_location: '3A-01',
      }] }
    }
    if (/select p\.id, p\.handover_id, p\.patient_key, p\.display_name, p\.location/.test(statement.text)) {
      return { rows: structuredClone(this.clinicalPatients) }
    }
    if (/update handovers set analysis=/.test(statement.text)) {
      this.analysis = JSON.parse(String(statement.values[0])) as Record<string, unknown>
      return { rows: [] }
    }
    return { rows: [] }
  }
}

describe('patient worksheet reviews without an imported sheet', () => {
  it('persists the reviewed field with the related handover analysis', async () => {
    let db = new WorksheetReviewDatabase()
    let result = await reviewShiftSheetPatientField(db as unknown as Database, {
      shiftId: 'shift-1',
      patientKey: 'patient-1',
      columnKey: 'diagnosis',
      value: 'Community-acquired pneumonia',
      decision: 'edited',
      userId: 'user-1',
    })

    assert.ok(result)
    assert.equal((result as { source?: string }).source, 'handover')
    assert.equal(db.analysis.headline, 'Existing analysis')
    let stored = (db.analysis.patientWorksheetFields as Record<string, Array<Record<string, unknown>>>)['patient-1']
    assert.equal(stored?.[0]?.columnKey, 'diagnosis')
    assert.equal(stored?.[0]?.finalAcceptedValue, 'Community-acquired pneumonia')
    assert.equal(stored?.[0]?.reviewStatus, 'human_verified')
  })

  it('resolves a derived legacy route key without relying on the shared placeholder key', async () => {
    let db = new WorksheetReviewDatabase(true, true, true)
    let result = await reviewShiftSheetPatientField(db as unknown as Database, {
      shiftId: 'shift-1',
      patientKey: 'molly-harper-3a-01',
      columnKey: 'diagnosis',
      value: 'Community-acquired pneumonia',
      decision: 'edited',
      userId: 'user-1',
    })

    assert.ok(result)
    let stored = db.analysis.patientWorksheetFields as Record<string, Array<Record<string, unknown>>>
    assert.equal(stored['molly-harper-3a-01']?.[0]?.finalAcceptedValue, 'Community-acquired pneumonia')
    assert.equal(stored['not-provided']?.[0]?.finalAcceptedValue, 'Legacy allergy review')
  })

  it('merges a unique legacy worksheet alias into the derived key before applying a review', async () => {
    let db = new WorksheetReviewDatabase(true, false, true)
    let result = await reviewShiftSheetPatientField(db as unknown as Database, {
      shiftId: 'shift-1',
      patientKey: 'molly-harper-3a-01',
      columnKey: 'planning',
      value: 'Oxygen requirement increased overnight',
      decision: 'edited',
      userId: 'user-1',
    })

    assert.ok(result)
    let stored = db.analysis.patientWorksheetFields as Record<string, Array<Record<string, unknown>>>
    let derived = stored['molly-harper-3a-01'] ?? []
    assert.equal(stored['not-provided'], undefined)
    assert.equal(derived.find((field) => field.columnKey === 'alerts_allergies')?.finalAcceptedValue, 'Legacy allergy review')
    assert.equal(derived.find((field) => field.columnKey === 'diagnosis')?.finalAcceptedValue, 'Current diagnosis')
    assert.equal(
      derived.find((field) => field.columnKey === 'planning')?.finalAcceptedValue,
      'Oxygen requirement increased overnight',
    )
  })
})

function worksheetField(columnKey: string, value: string) {
  return {
    label: columnKey,
    columnKey,
    value,
    reviewStatus: 'human_verified',
    reviewMethod: 'human',
    reviewDecision: 'edited',
    uncertain: false,
    issues: [],
    humanReviewedValue: value,
    finalAcceptedValue: value,
  }
}
