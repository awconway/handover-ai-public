import * as assert from 'remix/assert'
import { createCookie } from 'remix/cookie'
import { createSession } from 'remix/session'
import { createMemorySessionStorage } from 'remix/session-storage/memory'
import { describe, it } from 'remix/test'

import { createAppRouter } from '../../app/router.ts'
import { routes } from '../../app/routes.ts'

function harness() {
  let now = new Date('2026-07-16T00:00:00.000Z')
  let user = {
    id: 'user-1', full_name: 'Avery Clinician', occupation: 'Nurse', department: 'Medicine',
    created_at: now, updated_at: now, last_active_at: now,
  }
  let handover = {
    id: 'handover-1', created_by_user_id: user.id, source_handover_id: null, shift_id: null, source_shift_id: null,
    title: 'Ward handover', direction: 'incoming', source_department: 'ED', destination_department: 'Medicine',
    context_type: 'short-transfer', linked_patient_key: 'patient-1', linked_patient_display_name: 'Patient A',
    linked_patient_location: 'Bed 4', participants: [], shared_with_user_ids: [], consent_mode: 'agreed',
    priority_preference: 'balanced', notes: '', transcript: '', transcription_metadata: null,
    analysis: {
      patients: [
        { patientKey: 'patient-1', uncertainties: [{ id: 'uncertainty-1' }] },
        { patientKey: 'patient-2', uncertainties: [{ id: 'uncertainty-2' }] },
      ],
    },
    processing_status: 'completed', processing_started_at: now, error_message: null, version: 1,
    current_job_id: null, processing_lease_until: null, created_at: now, updated_at: now,
  }
  let existingTask = {
    id: 'existing-task', handover_id: 'other-handover', patient_key: 'patient-x', title: 'Do not overwrite',
    due_label: 'No due date set', due_at: null, priority: 'routine', status: 'open',
    reminder_enabled: false, carried_forward: false, source: 'manual', related_uncertainty_id: null,
    created_at: now, updated_at: now,
  }
  let createdTasks: Array<Record<string, unknown>> = []
  let taskStatusUpdates = 0
  let db: any = {
    async transaction(callback: (tx: any) => unknown) { return callback(db) },
    async find(table: any, id: string) {
      if ('full_name' in table) return id === user.id ? user : null
      if ('reminder_enabled' in table) return id === existingTask.id ? existingTask : null
      if ('consent_mode' in table) return id === handover.id ? handover : null
      return null
    },
    async findMany(table: any) {
      return 'full_name' in table ? [user] : []
    },
    async findOne(table: any, options: { where?: Record<string, unknown> }) {
      if (!('reminder_enabled' in table)) return null
      return createdTasks.find((task) =>
        task.handover_id === options.where?.handover_id
        && task.patient_key === options.where?.patient_key
        && task.related_uncertainty_id === options.where?.related_uncertainty_id,
      ) ?? null
    },
    async create(table: any, row: Record<string, unknown>) {
      if ('reminder_enabled' in table) {
        createdTasks.push(row)
        return row
      }
      throw new Error('Unexpected create')
    },
    async exec(statement: any) {
      let text = typeof statement === 'string' ? statement : statement.text
      let values = typeof statement === 'string' ? [] : statement.values
      if (/select h\.\* from handovers/i.test(text)) {
        return { rows: values[0] === handover.id && values[1] === user.id ? [handover] : [] }
      }
      if (/insert into handover_tasks/i.test(text)) {
        let task = {
          id: values[0], handover_id: values[1], patient_key: values[2], title: values[3],
          due_label: values[4], due_at: values[5], priority: values[6],
          status: values[7], reminder_enabled: values[8], carried_forward: values[9], source: values[10],
          related_uncertainty_id: values[11], created_at: values[12], updated_at: values[13],
        }
        let duplicate = createdTasks.some((existing) =>
          existing.handover_id === task.handover_id
          && existing.patient_key === task.patient_key
          && existing.related_uncertainty_id === task.related_uncertainty_id,
        )
        if (duplicate) return { rows: [] }
        createdTasks.push(task)
        return { rows: [task] }
      }
      if (/update handover_tasks/i.test(text)) taskStatusUpdates++
      return { rows: [] }
    },
  }
  let sessions = createMemorySessionStorage()
  let cookie = createCookie('task-domain-test', { secrets: ['test-secret'], httpOnly: true, sameSite: 'Lax', path: '/' })
  let runtime = { db, pool: {}, async ready() {}, async close() {} }
  let router = createAppRouter({ data: runtime as never, sessionStorage: sessions, sessionCookie: cookie, publicOrigins: ['http://localhost'] })
  return { router, sessions, cookie, createdTasks, existingTask, get taskStatusUpdates() { return taskStatusUpdates } }
}

async function authenticatedBrowser(h: ReturnType<typeof harness>) {
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

function validTask(token: string) {
  let body = new FormData()
  body.set('_csrf', token)
  body.set('label', 'Review oxygen target')
  body.set('patientKey', 'patient-1')
  body.set('dueLabel', 'No due date set')
  body.set('dueAt', '')
  body.set('dueLocal', '')
  body.set('priority', 'routine')
  body.set('status', 'open')
  body.set('reminderEnabled', 'false')
  body.set('source', 'manual')
  return body
}

async function post(h: ReturnType<typeof harness>, auth: Awaited<ReturnType<typeof authenticatedBrowser>>, href: string, body: FormData) {
  return h.router.fetch(new Request('http://localhost' + href, {
    method: 'POST',
    headers: { cookie: auth.cookie, origin: 'http://localhost' },
    body,
  }))
}

describe('task action domain validation', () => {
  it('rejects values outside the supported priority, status, and source domains', async () => {
    let h = harness()
    let auth = await authenticatedBrowser(h)
    let href = routes.actions.createTask.href({ handoverId: 'handover-1' })
    for (let [field, value] of [
      ['priority', 'catastrophic'],
      ['status', 'deleted'],
      ['source', 'remote'],
    ]) {
      let body = validTask(auth.token)
      body.set(field, value)
      let response = await post(h, auth, href, body)
      assert.equal(response.status, 400, `${field} must reject ${value}`)
    }
    assert.deepEqual(h.createdTasks, [])
  })

  it('rejects an unsupported status on the focused status-update route', async () => {
    let h = harness()
    let auth = await authenticatedBrowser(h)
    let body = new FormData()
    body.set('_csrf', auth.token)
    body.set('status', 'archived')
    let response = await post(h, auth, routes.actions.updateTask.href({ taskId: 'existing-task' }), body)
    assert.equal(response.status, 400)
    assert.equal(h.taskStatusUpdates, 0)
  })

  it('ignores a supplied task id and creates with a server-generated id', async () => {
    let h = harness()
    let auth = await authenticatedBrowser(h)
    let body = validTask(auth.token)
    body.set('id', h.existingTask.id)
    let response = await post(h, auth, routes.actions.createTask.href({ handoverId: 'handover-1' }), body)
    assert.equal(response.status, 303)
    assert.equal(h.createdTasks.length, 1)
    assert.notEqual(h.createdTasks[0]!.id, h.existingTask.id)
    assert.equal(h.existingTask.title, 'Do not overwrite')
  })

  it('uses server-owned creation defaults instead of supported but tampered task fields', async () => {
    let h = harness()
    let auth = await authenticatedBrowser(h)
    let body = validTask(auth.token)
    body.set('priority', 'urgent')
    body.set('status', 'done')
    body.set('source', 'transcript')

    let response = await post(h, auth, routes.actions.createTask.href({ handoverId: 'handover-1' }), body)

    assert.equal(response.status, 303)
    assert.equal(h.createdTasks.length, 1)
    assert.equal(h.createdTasks[0]!.priority, 'routine')
    assert.equal(h.createdTasks[0]!.status, 'open')
    assert.equal(h.createdTasks[0]!.source, 'manual')
  })

  it('rejects an uncertainty task when the uncertainty does not exist in the handover analysis', async () => {
    let h = harness()
    let auth = await authenticatedBrowser(h)
    let response = await post(
      h,
      auth,
      routes.actions.createUncertaintyTask.href({ handoverId: 'handover-1', uncertaintyId: 'missing-uncertainty' }),
      validTask(auth.token),
    )

    assert.equal(response.status, 404)
    assert.deepEqual(h.createdTasks, [])
  })

  it('rejects an uncertainty task associated with a different patient', async () => {
    let h = harness()
    let auth = await authenticatedBrowser(h)
    let response = await post(
      h,
      auth,
      routes.actions.createUncertaintyTask.href({ handoverId: 'handover-1', uncertaintyId: 'uncertainty-2' }),
      validTask(auth.token),
    )

    assert.equal(response.status, 404)
    assert.deepEqual(h.createdTasks, [])
  })

  it('creates an uncertainty task only for its analysed patient', async () => {
    let h = harness()
    let auth = await authenticatedBrowser(h)
    let response = await post(
      h,
      auth,
      routes.actions.createUncertaintyTask.href({ handoverId: 'handover-1', uncertaintyId: 'uncertainty-1' }),
      validTask(auth.token),
    )

    assert.equal(response.status, 303)
    assert.equal(h.createdTasks.length, 1)
    assert.equal(h.createdTasks[0]!.patient_key, 'patient-1')
    assert.equal(h.createdTasks[0]!.related_uncertainty_id, 'uncertainty-1')
    assert.equal(h.createdTasks[0]!.source, 'uncertainty')
  })

  it('treats a repeated uncertainty-task submission as a successful replay', async () => {
    let h = harness()
    let auth = await authenticatedBrowser(h)
    let href = routes.actions.createUncertaintyTask.href({
      handoverId: 'handover-1',
      uncertaintyId: 'uncertainty-1',
    })

    let first = await post(h, auth, href, validTask(auth.token))
    let replay = await post(h, auth, href, validTask(auth.token))

    assert.equal(first.status, 303)
    assert.equal(replay.status, 303)
    assert.equal(h.createdTasks.length, 1)
  })
})
