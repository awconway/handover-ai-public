import * as assert from 'remix/assert'
import { createCookie } from 'remix/cookie'
import { createSession } from 'remix/session'
import { createMemorySessionStorage } from 'remix/session-storage/memory'
import { describe, it } from 'remix/test'

import { createAppRouter } from '../../app/router.ts'
import { routes } from '../../app/routes.ts'
import { buildShiftWorkspaceReadModel } from '../../app/data/workspace-read-model.ts'
import { frameMutationRequestHeader, frameMutationRequestValue } from '../../app/utils/frame-mutation.ts'

function harness(options: { withHandover?: boolean; legacy?: boolean; legacySibling?: boolean } = {}) {
  let legacy = options.legacy === true
  let legacySibling = legacy && options.legacySibling !== false
  let workspacePatientKey = legacy ? 'molly-harper-3a-01' : 'patient-1'
  let storedPatientKey = legacy ? 'not-provided' : 'patient-1'
  let user = {
    id: 'user-1', full_name: 'Avery Clinician', occupation: 'Nurse', department: 'Medicine',
    created_at: new Date(), updated_at: new Date(), last_active_at: new Date(),
  }
  let shift = {
    id: 'shift-1', created_by_user_id: user.id, title: 'Evening cover', department: 'Medicine',
    assigned_user_ids: [user.id], notes: '', patient_order: [workspacePatientKey], status: 'active',
    created_at: new Date(), updated_at: new Date(),
  }
  let sheetPatient = legacy ? null : {
    id: 'sheet-patient-1', shift_id: shift.id, patient_key: 'patient-1', display_name: 'Molly Harper', location: '3A-01',
    fields: [
      { label: 'Name', columnKey: 'name', value: 'Molly Harper', reviewStatus: 'automatic', reviewMethod: 'automatic', uncertain: false, issues: [] },
      { label: 'Bed', columnKey: 'bed', value: '3A-01', reviewStatus: 'automatic', reviewMethod: 'automatic', uncertain: false, issues: [] },
    ],
    raw_text: '', source_file_name: 'ward.csv', source_file_key: 'ward.csv', source_file_content_type: 'text/csv',
    source_file_size_bytes: 100, extraction_method: 'text', row_index: 0, imported_by_user_id: user.id,
    imported_at: new Date(), updated_at: new Date(),
  }
  let handover = options.withHandover === false ? null : {
    id: 'handover-1', created_by_user_id: user.id, source_handover_id: null, shift_id: shift.id, source_shift_id: null,
    title: 'Delivering handover · Molly Harper', direction: 'outgoing', source_department: 'Medicine', destination_department: '',
    context_type: 'shift-handover', linked_patient_key: storedPatientKey, linked_patient_display_name: 'Molly Harper',
    linked_patient_location: '3A-01', participants: [], shared_with_user_ids: [], consent_mode: 'agreed', priority_preference: 'balanced',
    notes: '', transcript: '', transcription_metadata: null,
    analysis: { patients: [
      {
        patientKey: storedPatientKey,
        displayName: 'Molly Harper',
        location: '3A-01',
        tasks: [{ id: 'task-patient-1', title: 'Review oxygen target' }],
      },
      ...(legacySibling ? [{
        patientKey: storedPatientKey,
        displayName: 'Ford Prefect',
        location: '3A-02',
        tasks: [{ id: 'task-patient-2', title: 'Repeat blood pressure' }],
      }] : []),
    ], ...(legacy ? {
      patientWorksheetFields: {
        [workspacePatientKey]: [{
          label: 'Diagnosis',
          columnKey: 'diagnosis',
          value: 'Current diagnosis',
          reviewStatus: 'human_verified',
          reviewMethod: 'human',
          reviewDecision: 'edited',
          uncertain: false,
          issues: [],
          finalAcceptedValue: 'Current diagnosis',
        }],
        'not-provided': [{
          label: 'Allergies',
          columnKey: 'alerts_allergies',
          value: 'Ambiguous legacy review',
          reviewStatus: 'human_verified',
          reviewMethod: 'human',
          reviewDecision: 'edited',
          uncertain: false,
          issues: [],
          finalAcceptedValue: 'Ambiguous legacy review',
        }],
      },
    } : {}) },
    processing_status: 'completed', processing_started_at: new Date(), error_message: null, version: 1,
    current_job_id: null, processing_lease_until: null, created_at: new Date(), updated_at: new Date(),
  }
  let clinicalPatient = handover ? {
    id: 'clinical-patient-1', handover_id: handover.id, patient_key: storedPatientKey, display_name: 'Molly Harper', location: '3A-01',
    acuity_score: 1, risk_score: 1, workflow_score: 1, created_at: new Date(),
  } : null
  let otherClinicalPatient = handover && legacySibling ? {
    id: 'clinical-patient-2', handover_id: handover.id, patient_key: storedPatientKey, display_name: 'Ford Prefect', location: '3A-02',
    acuity_score: 1, risk_score: 1, workflow_score: 1, created_at: new Date(),
  } : null
  let handoverTask = handover ? {
    id: 'task-patient-1', handover_id: handover.id, patient_key: storedPatientKey,
    title: 'Review oxygen target', due_label: 'No due date set', due_at: null, priority: 'routine',
    status: 'open', reminder_enabled: false, carried_forward: false, source: 'transcript',
    related_uncertainty_id: null, created_at: new Date(), updated_at: new Date(),
  } : null
  let otherHandoverTask = handover && legacySibling ? {
    id: 'task-patient-2', handover_id: handover.id, patient_key: storedPatientKey,
    title: 'Repeat blood pressure', due_label: 'No due date set', due_at: null, priority: 'routine',
    status: 'open', reminder_enabled: false, carried_forward: false, source: 'transcript',
    related_uncertainty_id: null, created_at: new Date(), updated_at: new Date(),
  } : null

  let db: any = {
    async find(table: any, id: string) {
      if ('full_name' in table) return id === user.id ? user : null
      if ('consent_mode' in table) return handover?.id === id ? handover : null
      return null
    },
    async findMany(table: any, query?: any) {
      if ('full_name' in table) return [user]
      if ('source_file_key' in table && query?.where?.shift_id === shift.id) return sheetPatient ? [sheetPatient] : []
      return []
    },
    async transaction<T>(callback: (tx: any) => Promise<T>) { return callback(db) },
    async exec(statement: any) {
      let text = typeof statement === 'string' ? statement : statement.text
      let values = typeof statement === 'string' ? [] : statement.values

      if (/select id, display_name, location, fields[\s\S]*from shift_sheet_patients[\s\S]*for update/i.test(text)) {
        return { rows: sheetPatient && values[0] === shift.id && values[1] === sheetPatient.patient_key ? [sheetPatient] : [] }
      }
      if (/select h\.id, h\.title, h\.direction[\s\S]*for update of h/i.test(text)) {
        return { rows: handover ? [handover] : [] }
      }
      if (/select p\.id, p\.handover_id, p\.patient_key, p\.display_name, p\.location/i.test(text)) {
        return { rows: [clinicalPatient, otherClinicalPatient].filter(Boolean) }
      }
      if (/select t\.id, t\.handover_id, t\.patient_key, t\.related_uncertainty_id[\s\S]*for update of t/i.test(text)) {
        return { rows: [handoverTask, otherHandoverTask].filter(Boolean) }
      }
      if (/update shift_sheet_patients[\s\S]*set display_name/i.test(text)) {
        if (sheetPatient && values[3] === sheetPatient.id) {
          sheetPatient.display_name = String(values[0])
          sheetPatient.location = String(values[1])
          sheetPatient.fields = JSON.parse(String(values[2]))
          sheetPatient.updated_at = new Date()
        }
        return { rows: [] }
      }
      if (/update handover_patients[\s\S]*set[\s\S]*display_name/i.test(text)) {
        let promotesKey = /set patient_key/i.test(text)
        let ids = Array.isArray(values[promotesKey ? 3 : 2]) ? values[promotesKey ? 3 : 2] : []
        for (let patient of [clinicalPatient, otherClinicalPatient]) {
          if (!patient || !ids.includes(patient.id)) continue
          if (promotesKey) patient.patient_key = String(values[0])
          patient.display_name = String(values[promotesKey ? 1 : 0])
          patient.location = String(values[promotesKey ? 2 : 1])
        }
        return { rows: [] }
      }
      if (/update handover_tasks[\s\S]*set patient_key/i.test(text)) {
        let ids = Array.isArray(values[2]) ? values[2] : []
        for (let task of [handoverTask, otherHandoverTask]) {
          if (!task || task.handover_id !== values[1] || !ids.includes(task.id)) continue
          task.patient_key = String(values[0])
          task.updated_at = new Date()
        }
        return { rows: [] }
      }
      if (/update handovers[\s\S]*set title/i.test(text)) {
        if (handover && values[5] === handover.id && values[6] === shift.id) {
          handover.title = String(values[0])
          if (values[1] != null) handover.linked_patient_key = String(values[1])
          handover.linked_patient_display_name = String(values[2])
          handover.linked_patient_location = String(values[3])
          handover.analysis = values[4] == null ? null : JSON.parse(String(values[4]))
          handover.updated_at = new Date()
        }
        return { rows: [] }
      }
      if (/select distinct\s+h\.id,[\s\S]*processing_status/i.test(text)) return { rows: [] }
      if (/select distinct h\.\* from handovers/i.test(text)) return { rows: handover ? [handover] : [] }
      if (/select p\.\* from handover_patients/i.test(text)) {
        return { rows: [clinicalPatient, otherClinicalPatient].filter(Boolean) }
      }
      if (/select \* from shifts where id/i.test(text)) return { rows: values[0] === shift.id ? [shift] : [] }
      if (/select \* from shifts[\s\S]*where created_by_user_id/i.test(text)) return { rows: [shift] }
      return { rows: [] }
    },
  }

  let sessions = createMemorySessionStorage()
  let cookie = createCookie('shift-patient-test', { secrets: ['test-secret'], httpOnly: true, sameSite: 'Lax', path: '/' })
  let runtime = { db, pool: {}, async ready() {}, async close() {} }
  let router = createAppRouter({ data: runtime as never, sessionStorage: sessions, sessionCookie: cookie, publicOrigins: ['http://localhost'] })
  return {
    router,
    sessions,
    cookie,
    shift,
    sheetPatient,
    handover,
    clinicalPatient,
    otherClinicalPatient,
    handoverTask,
    otherHandoverTask,
    workspacePatientKey,
  }
}

async function browser(h: ReturnType<typeof harness>) {
  let session = createSession()
  session.set('auth', { userId: 'user-1' })
  let id = await h.sessions.save(session)
  assert.ok(id)
  let initialCookie = await h.cookie.serialize(id)
  let page = await h.router.fetch(new Request('http://localhost/', { headers: { cookie: initialCookie } }))
  let token = (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1]
  assert.ok(token)
  return { token, cookie: page.headers.get('set-cookie')?.split(';', 1)[0] ?? initialCookie }
}

async function updatePatient(
  h: ReturnType<typeof harness>,
  auth: Awaited<ReturnType<typeof browser>>,
  handoverId?: string,
  enhanced = false,
) {
  let body = new FormData()
  body.set('_csrf', auth.token)
  body.set('displayName', 'Molly Harper Updated')
  body.set('location', 'Ward 4')
  if (handoverId) body.set('handoverId', handoverId)
  return h.router.fetch(new Request('http://localhost' + routes.actions.updateShiftPatient.href({
    shiftId: h.shift.id,
    patientKey: h.workspacePatientKey,
  }), {
    method: 'POST',
    headers: {
      cookie: auth.cookie,
      origin: 'http://localhost',
      ...(enhanced ? { [frameMutationRequestHeader]: frameMutationRequestValue } : {}),
    },
    body,
  }))
}

describe('shift patient details action', () => {
  it('authorises the related handover and updates sheet, clinical, linked, and analysis projections together', async () => {
    let h = harness(), auth = await browser(h)
    let response = await updatePatient(h, auth, 'handover-1')
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), routes.workspace.shift.href({ shiftId: h.shift.id }))
    assert.equal(h.sheetPatient?.display_name, 'Molly Harper Updated')
    assert.equal(h.sheetPatient?.location, 'Ward 4')
    assert.equal((h.sheetPatient?.fields as any[]).find((field) => field.columnKey === 'name')?.finalAcceptedValue, 'Molly Harper Updated')
    assert.equal((h.sheetPatient?.fields as any[]).find((field) => field.columnKey === 'bed')?.finalAcceptedValue, 'Ward 4')
    assert.equal(h.clinicalPatient?.display_name, 'Molly Harper Updated')
    assert.equal(h.clinicalPatient?.location, 'Ward 4')
    assert.equal(h.handover?.linked_patient_display_name, 'Molly Harper Updated')
    assert.equal(h.handover?.linked_patient_location, 'Ward 4')
    assert.equal((h.handover?.analysis as any)?.patients[0].displayName, 'Molly Harper Updated')
    assert.equal(h.handover?.title, 'Delivering handover · Molly Harper Updated')
  })

  it('supports a sheet-only patient and rejects an unrelated handover id without writing', async () => {
    let sheetOnly = harness({ withHandover: false }), auth = await browser(sheetOnly)
    let response = await updatePatient(sheetOnly, auth)
    assert.equal(response.status, 303)
    assert.equal(sheetOnly.sheetPatient?.display_name, 'Molly Harper Updated')

    let guarded = harness(), guardedAuth = await browser(guarded)
    response = await updatePatient(guarded, guardedAuth, 'another-handover')
    assert.equal(response.status, 404)
    assert.equal(guarded.sheetPatient?.display_name, 'Molly Harper')
    assert.equal(guarded.handover?.linked_patient_display_name, 'Molly Harper')
  })

  it('also suppresses direct action redirects for enhanced Frame mutations', async () => {
    let h = harness(), auth = await browser(h)

    let response = await updatePatient(h, auth, 'handover-1', true)

    assert.equal(response.status, 204)
    assert.equal(response.headers.get('location'), null)
    assert.equal(h.sheetPatient?.display_name, 'Molly Harper Updated')
  })

  it('resolves a derived legacy route key without updating sibling placeholder rows', async () => {
    let h = harness({ legacy: true }), auth = await browser(h)

    let response = await updatePatient(h, auth, 'handover-1')

    assert.equal(response.status, 303)
    assert.equal(h.clinicalPatient?.display_name, 'Molly Harper Updated')
    assert.equal(h.clinicalPatient?.location, 'Ward 4')
    assert.equal(h.clinicalPatient?.patient_key, h.workspacePatientKey)
    assert.equal(h.handoverTask?.patient_key, h.workspacePatientKey)
    assert.equal(h.otherClinicalPatient?.display_name, 'Ford Prefect')
    assert.equal(h.otherClinicalPatient?.location, '3A-02')
    assert.equal(h.otherClinicalPatient?.patient_key, 'not-provided')
    assert.equal(h.otherHandoverTask?.patient_key, 'not-provided')
    assert.equal(h.handover?.linked_patient_key, h.workspacePatientKey)
    assert.equal(h.handover?.linked_patient_display_name, 'Molly Harper Updated')
    assert.equal((h.handover?.analysis as any)?.patients[0].patientKey, h.workspacePatientKey)
    assert.equal((h.handover?.analysis as any)?.patients[0].displayName, 'Molly Harper Updated')
    assert.equal((h.handover?.analysis as any)?.patients[1].patientKey, 'not-provided')
    assert.equal((h.handover?.analysis as any)?.patients[1].displayName, 'Ford Prefect')
    assert.equal(
      (h.handover?.analysis as any)?.patientWorksheetFields[h.workspacePatientKey][0].finalAcceptedValue,
      'Current diagnosis',
    )
    assert.equal(
      (h.handover?.analysis as any)?.patientWorksheetFields['not-provided'][0].finalAcceptedValue,
      'Ambiguous legacy review',
    )
    assert.deepEqual(h.shift.patient_order, [h.workspacePatientKey])

    let model = buildShiftWorkspaceReadModel({
      shift: h.shift as never,
      handovers: h.handover ? [h.handover as never] : [],
      sheetPatients: [],
      handoverPatients: [h.clinicalPatient, h.otherClinicalPatient].filter(Boolean) as never[],
      tasks: [],
    })
    assert.deepEqual(model.patients.map((patient) => patient.key), [
      h.workspacePatientKey,
      'ford-prefect-3a-02',
    ])
  })

  it('migrates a uniquely owned legacy worksheet alias while stabilising its patient key', async () => {
    let h = harness({ legacy: true, legacySibling: false }), auth = await browser(h)

    let response = await updatePatient(h, auth, 'handover-1')

    assert.equal(response.status, 303)
    let collection = (h.handover?.analysis as any)?.patientWorksheetFields
    assert.equal(collection['not-provided'], undefined)
    assert.equal(
      collection[h.workspacePatientKey].find((field: any) => field.columnKey === 'alerts_allergies')?.finalAcceptedValue,
      'Ambiguous legacy review',
    )
    assert.equal(
      collection[h.workspacePatientKey].find((field: any) => field.columnKey === 'diagnosis')?.finalAcceptedValue,
      'Current diagnosis',
    )
    assert.equal(h.clinicalPatient?.patient_key, h.workspacePatientKey)
    assert.equal(h.handoverTask?.patient_key, h.workspacePatientKey)
    assert.equal(h.handover?.linked_patient_key, h.workspacePatientKey)
  })
})
