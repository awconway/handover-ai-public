import * as assert from 'remix/assert'
import { createCookie } from 'remix/cookie'
import { createSession } from 'remix/session'
import { createMemorySessionStorage } from 'remix/session-storage/memory'
import { describe, it } from 'remix/test'

import { createAppRouter } from '../../app/router.ts'
import { patientWorkspaceHref, routes } from '../../app/routes.ts'

describe('patient Actions reconciliation', () => {
  it('renders only the persisted placeholder task linked to each canonical patient', async () => {
    let fixture = createFixture()
    let cookie = await authenticatedCookie(fixture)

    let bed1 = await fixture.router.fetch(patientActionsRequest('alex-lee-bed-1', cookie))
    let bed1Html = await bed1.text()
    assert.equal(bed1.status, 200)
    assert.match(bed1Html, /Review oxygen target/)
    assert.doesNotMatch(bed1Html, /Repeat blood pressure/)
    assert.doesNotMatch(bed1Html, /not-provided/)

    let bed2 = await fixture.router.fetch(patientActionsRequest('alex-lee-bed-2', cookie))
    let bed2Html = await bed2.text()
    assert.equal(bed2.status, 200)
    assert.match(bed2Html, /Repeat blood pressure/)
    assert.doesNotMatch(bed2Html, /Review oxygen target/)
    assert.doesNotMatch(bed2Html, /not-provided/)
  })

  it('rejects a raw placeholder alias shared by more than one patient', async () => {
    let fixture = createFixture()
    let cookie = await authenticatedCookie(fixture)

    let response = await fixture.router.fetch(patientActionsRequest('not-provided', cookie))

    assert.equal(response.status, 404)
  })

  it('links a legacy handover review back to its derived patient identity', async () => {
    let fixture = createFixture()
    fixture.sheetPatients.splice(0)
    let cookie = await authenticatedCookie(fixture)

    let response = await fixture.router.fetch(new Request(
      'http://localhost' + routes.workspace.shiftHandoverReview.href({
        shiftId: 'shift-1',
        handoverId: 'handover-1',
        reviewTab: 'details',
      }),
      { headers: { cookie, 'x-remix-target': 'workspace' } },
    ))
    let html = await response.text()

    assert.equal(response.status, 200)
    assert.match(html, /href="\/shift\/shift-1\/patients\/alex-lee-bed-1"/)
    assert.doesNotMatch(html, /href="\/shift\/shift-1\/patients\/not-provided"/)
  })

  it('keeps shift breadcrumbs when a placeholder patient cannot be resolved safely', async () => {
    let fixture = createFixture()
    fixture.handover.analysis = {
      patients: [{
        patientKey: 'not-provided',
        displayName: 'Patient',
        location: 'Unknown',
        tasks: [],
      }],
    }
    fixture.handover.linked_patient_display_name = 'Patient'
    fixture.handover.linked_patient_location = 'Unknown'
    let cookie = await authenticatedCookie(fixture)

    let response = await fixture.router.fetch(new Request(
      'http://localhost' + routes.workspace.shiftHandoverReview.href({
        shiftId: 'shift-1',
        handoverId: 'handover-1',
        reviewTab: 'details',
      }),
      { headers: { cookie, 'x-remix-target': 'workspace' } },
    ))
    let html = await response.text()

    assert.equal(response.status, 200)
    assert.match(html, new RegExp(`href="${routes.workspace.shift.href({ shiftId: 'shift-1' })}"`))
    assert.doesNotMatch(html, /\/shift\/shift-1\/patients\/not-provided/)
  })
})

function createFixture() {
  let now = new Date('2026-07-14T00:00:00.000Z')
  let user = {
    id: 'user-1',
    full_name: 'Avery Clinician',
    occupation: 'Nurse',
    department: 'Medicine',
    created_at: now,
    updated_at: now,
    last_active_at: now,
  }
  let shift = {
    id: 'shift-1',
    created_by_user_id: user.id,
    title: 'Evening cover',
    department: 'Medicine',
    assigned_user_ids: [user.id],
    notes: '',
    patient_order: ['alex-lee-bed-1', 'alex-lee-bed-2'],
    status: 'active',
    created_at: now,
    updated_at: now,
  }
  let sheetPatients = [
    sheetPatient('sheet-bed-1', 'alex-lee-bed-1', 'Bed 1', 0),
    sheetPatient('sheet-bed-2', 'alex-lee-bed-2', 'Bed 2', 1),
  ]
  let handover = {
    id: 'handover-1',
    created_by_user_id: user.id,
    source_handover_id: null,
    shift_id: shift.id,
    source_shift_id: null,
    title: 'Handover',
    direction: 'incoming',
    source_department: 'Medicine',
    destination_department: '',
    context_type: 'shift-handover',
    linked_patient_key: 'not-provided',
    linked_patient_display_name: 'Alex Lee',
    linked_patient_location: 'Bed 1',
    participants: [],
    shared_with_user_ids: [],
    consent_mode: 'agreed',
    priority_preference: 'balanced',
    notes: '',
    transcript: '',
    transcription_metadata: null,
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
    processing_status: 'completed',
    processing_started_at: now,
    error_message: null,
    version: 1,
    current_job_id: null,
    processing_lease_until: null,
    created_at: now,
    updated_at: now,
  }
  let clinicalPatients = [
    clinicalPatient('clinical-bed-1', 'Bed 1'),
    clinicalPatient('clinical-bed-2', 'Bed 2'),
  ]
  let tasks = [
    task('task-bed-1', 'Review oxygen target'),
    task('task-bed-2', 'Repeat blood pressure'),
  ]
  let db = {
    async find(table: Record<string, unknown>, id: string) {
      return 'full_name' in table && id === user.id ? user : null
    },
    async findMany(table: Record<string, unknown>) {
      return 'full_name' in table ? [user] : []
    },
    async exec(statement: { text?: string; values?: unknown[] }) {
      let text = statement.text ?? ''
      let values = statement.values ?? []
      if (/select \* from shifts where id/i.test(text)) return { rows: values[0] === shift.id ? [shift] : [] }
      if (/select \* from shifts[\s\S]*where created_by_user_id/i.test(text)) return { rows: [shift] }
      if (/select p\.\* from shift_sheet_patients p/i.test(text)) {
        return {
          rows: sheetPatients.filter((patient) =>
            patient.shift_id === values[0]
            && (!/p\.patient_key\s*=/i.test(text) || patient.patient_key === values[1]),
          ),
        }
      }
      if (/select h\.\* from handovers h/i.test(text)) return { rows: values[0] === handover.id ? [handover] : [] }
      if (/select distinct h\.\* from handovers h/i.test(text)) return { rows: [handover] }
      if (/select distinct t\.\* from handover_tasks t/i.test(text)) return { rows: tasks }
      if (/select p\.\* from handover_patients p/i.test(text)) return { rows: clinicalPatients }
      return { rows: [] }
    },
  }
  let sessions = createMemorySessionStorage()
  let sessionCookie = createCookie('patient-actions-test', {
    secrets: ['test-secret'],
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
  })
  let runtime = { db, pool: {}, async ready() {}, async close() {} }
  let router = createAppRouter({
    data: runtime as never,
    sessionStorage: sessions,
    sessionCookie,
    publicOrigins: ['http://localhost'],
  })
  return { router, sessions, sessionCookie, sheetPatients, handover }

  function sheetPatient(id: string, patientKey: string, location: string, rowIndex: number) {
    return {
      id,
      shift_id: shift.id,
      patient_key: patientKey,
      display_name: 'Alex Lee',
      location,
      fields: [],
      raw_text: '',
      source_file_name: 'ward.csv',
      source_file_key: 'ward.csv',
      source_file_content_type: 'text/csv',
      source_file_size_bytes: 100,
      extraction_method: 'text',
      row_index: rowIndex,
      imported_by_user_id: user.id,
      imported_at: now,
      updated_at: now,
    }
  }

  function clinicalPatient(id: string, location: string) {
    return {
      id,
      handover_id: handover.id,
      patient_key: 'not-provided',
      display_name: 'Alex Lee',
      location,
      acuity_score: 1,
      risk_score: 1,
      workflow_score: 1,
      priority_reason: '',
      created_at: now,
    }
  }

  function task(id: string, title: string) {
    return {
      id,
      handover_id: handover.id,
      patient_key: 'not-provided',
      title,
      due_label: 'No due date set',
      due_at: null,
      priority: 'routine',
      status: 'open',
      reminder_enabled: false,
      carried_forward: false,
      source: 'transcript',
      related_uncertainty_id: null,
      created_at: now,
      updated_at: now,
    }
  }
}

function patientActionsRequest(patientKey: string, cookie: string) {
  let href = patientWorkspaceHref({ shiftId: 'shift-1', patientKey, tab: 'actions' })
  return new Request(`http://localhost${href}`, {
    headers: { cookie, 'x-remix-target': 'workspace' },
  })
}

async function authenticatedCookie(fixture: ReturnType<typeof createFixture>) {
  let session = createSession()
  session.set('auth', { userId: 'user-1' })
  let id = await fixture.sessions.save(session)
  assert.ok(id)
  return fixture.sessionCookie.serialize(id)
}
