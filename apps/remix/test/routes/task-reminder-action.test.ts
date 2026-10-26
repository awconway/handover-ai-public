import * as assert from 'remix/assert'
import { createCookie } from 'remix/cookie'
import { createSession } from 'remix/session'
import { createMemorySessionStorage } from 'remix/session-storage/memory'
import { describe, it } from 'remix/test'

import { createAppRouter } from '../../app/router.ts'
import { routes } from '../../app/routes.ts'
import { frameMutationRequestHeader, frameMutationRequestValue } from '../../app/utils/frame-mutation.ts'

function harness() {
  let now = new Date('2026-07-14T06:00:00.000Z')
  let user = {
    id: 'user-1', full_name: 'Avery Clinician', occupation: 'Nurse', department: 'Medicine',
    created_at: now, updated_at: now, last_active_at: now,
  }
  let handover = {
    id: 'handover-1', created_by_user_id: user.id, source_handover_id: null, shift_id: null, source_shift_id: null,
    title: 'Ward handover', direction: 'incoming', source_department: 'ED', destination_department: 'Medicine',
    context_type: 'short-transfer', linked_patient_key: 'patient-1', linked_patient_display_name: 'Patient A',
    linked_patient_location: 'Bed 4', participants: [], shared_with_user_ids: [], consent_mode: 'agreed',
    priority_preference: 'balanced', notes: '', transcript: '', transcription_metadata: null, analysis: {},
    processing_status: 'completed', processing_started_at: now, error_message: null, version: 1,
    current_job_id: null, processing_lease_until: null, created_at: now, updated_at: now,
  }
  let task = {
    id: 'task-1', handover_id: handover.id, patient_key: 'patient-1', title: 'Review oxygen target',
    due_label: 'No due date set', due_at: null, priority: 'routine', status: 'open',
    reminder_enabled: true, carried_forward: false, source: 'manual', related_uncertainty_id: null,
    created_at: now, updated_at: now,
  }
  let db: any = {
    async transaction(callback: (tx: any) => unknown) { return callback(db) },
    async find(table: any, id: string) {
      if ('full_name' in table) return id === user.id ? user : null
      if ('reminder_enabled' in table) return id === task.id ? task : null
      if ('consent_mode' in table) return id === handover.id ? handover : null
      return null
    },
    async findMany(table: any) {
      if ('full_name' in table) return [user]
      return []
    },
    async update(table: any, id: string, patch: Record<string, unknown>) {
      if ('reminder_enabled' in table && id === task.id) {
        Object.assign(task, patch)
        return task
      }
      return null
    },
    async exec(statement: any) {
      let text = typeof statement === 'string' ? statement : statement.text
      let values = typeof statement === 'string' ? [] : statement.values
      if (/select handover_id from handover_tasks/i.test(text)) {
        return { rows: values[0] === task.id ? [{ handover_id: task.handover_id }] : [] }
      }
      if (/select \* from handover_tasks/i.test(text)) {
        return { rows: values[0] === task.id && values[1] === task.handover_id ? [task] : [] }
      }
      if (/select h\.\* from handovers/i.test(text)) {
        return { rows: values[0] === handover.id && values[1] === user.id ? [handover] : [] }
      }
      return { rows: [] }
    },
  }
  let sessions = createMemorySessionStorage()
  let cookie = createCookie('task-reminder-test', { secrets: ['test-secret'], httpOnly: true, sameSite: 'Lax', path: '/' })
  let runtime = { db, pool: {}, async ready() {}, async close() {} }
  let router = createAppRouter({ data: runtime as never, sessionStorage: sessions, sessionCookie: cookie, publicOrigins: ['http://localhost'] })
  return { router, sessions, cookie, task }
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

async function setReminder(
  h: ReturnType<typeof harness>,
  auth: Awaited<ReturnType<typeof authenticatedBrowser>>,
  enabled: boolean,
  enhanced = false,
) {
  let body = new FormData()
  body.set('_csrf', auth.token)
  body.set('_intent', 'reminder')
  body.set('reminderEnabled', String(enabled))
  return h.router.fetch(new Request('http://localhost' + routes.actions.updateTask.href({ taskId: h.task.id }), {
    method: 'POST',
    headers: {
      cookie: auth.cookie,
      origin: 'http://localhost',
      ...(enhanced ? { [frameMutationRequestHeader]: frameMutationRequestValue } : {}),
    },
    body,
  }))
}

describe('task reminder action', () => {
  it('persists both off and on through the ordinary Remix POST/303 contract', async () => {
    let h = harness()
    let auth = await authenticatedBrowser(h)

    let response = await setReminder(h, auth, false)
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), routes.workspace.handoverReview.href({ handoverId: 'handover-1', reviewTab: 'tasks' }))
    assert.equal(h.task.reminder_enabled, false)

    auth.cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? auth.cookie
    response = await setReminder(h, auth, true)
    assert.equal(response.status, 303)
    assert.equal(h.task.reminder_enabled, true)
  })

  it('completes an enhanced mutation without a redirect for the Frame to follow', async () => {
    let h = harness()
    let auth = await authenticatedBrowser(h)

    let response = await setReminder(h, auth, false, true)

    assert.equal(response.status, 204)
    assert.equal(response.headers.get('location'), null)
    assert.equal(await response.text(), '')
    assert.equal(h.task.reminder_enabled, false)
  })
})
