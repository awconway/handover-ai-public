import * as assert from 'remix/assert'
import { createCookie } from 'remix/cookie'
import { createSession } from 'remix/session'
import { createMemorySessionStorage } from 'remix/session-storage/memory'
import { describe, it } from 'remix/test'

import { createAppRouter } from '../../app/router.ts'
import { routes } from '../../app/routes.ts'

function fixture() {
  let user = {
    id: 'user-1',
    full_name: 'Avery Clinician',
    occupation: 'Nurse',
    department: 'General Medicine',
    created_at: new Date(),
    updated_at: new Date(),
    last_active_at: new Date(),
  }
  let processingRow = {
    id: 'handover-1',
    title: 'Private patient title',
    shift_id: 'shift-1',
    source_shift_id: 'shift-source',
    linked_patient_key: 'not-provided',
    linked_patient_display_name: 'Private patient name',
    linked_patient_location: 'Private bed',
    patient_keys: ['not-provided'],
    processing_status: 'analysing',
    version: 3,
    updated_at: new Date('2026-07-13T06:05:04.000Z'),
    error_message: 'Provider response included private diagnostic detail.',
    transcript: 'Private transcript text.',
    analysis: {
      analysisReadiness: {
        overview: true,
        patients: true,
        checklist: true,
        uncertainty: true,
      },
      patients: [{
        patientKey: 'not-provided',
        displayName: 'Private patient name',
        location: 'Private bed',
      }],
    },
  }
  let db = {
    async find(_table: unknown, id: string) { return id === user.id ? user : null },
    async findMany() { return [] },
    async exec(statement: { text: string }) {
      if (statement.text.includes('select h.* from handovers h')) return { rows: [processingRow] }
      return statement.text.includes("h.processing_status in ('queued', 'transcribing', 'analysing')")
        ? { rows: [processingRow] }
        : { rows: [] }
    },
  }
  let listeners = new Set<(handoverId: string | null) => void>()
  let processingEvents = {
    async start() {},
    subscribe(listener: (handoverId: string | null) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async close() { listeners.clear() },
    emit(handoverId: string | null) { for (let listener of [...listeners]) listener(handoverId) },
  }
  let runtime = { db, pool: {}, async ready() {}, async close() {} }
  let storage = createMemorySessionStorage()
  let cookie = createCookie('test-handover-session', {
    secrets: ['test-session-secret'],
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
  })
  return { runtime: runtime as never, storage, cookie, processingEvents }
}

async function authenticatedCookie(f: ReturnType<typeof fixture>) {
  let session = createSession()
  session.set('auth', { userId: 'user-1' })
  let id = await f.storage.save(session)
  assert.ok(id)
  return f.cookie.serialize(id)
}

describe('processing polling resource', () => {
  it('returns a privacy-safe active revision signal with route-scoped Frame relevance', async () => {
    let f = fixture()
    let router = createAppRouter({
      data: f.runtime,
      sessionStorage: f.storage,
      sessionCookie: f.cookie,
    })
    let cookie = await authenticatedCookie(f)
    let response = await router.fetch(new Request(
      'http://localhost' + routes.resources.processingAll.href(),
      { headers: { cookie, accept: 'application/json' } },
    ))

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    let body = await response.text()
    let payload = JSON.parse(body)
    assert.deepEqual(payload, {
      items: [{
        id: 'handover-1',
        status: 'analysing',
        href: routes.workspace.shiftHandoverReview.href({
          shiftId: 'shift-1',
          handoverId: 'handover-1',
          reviewTab: 'details',
        }),
        revision: 3,
        updatedAt: '2026-07-13T06:05:04.000Z',
        readiness: '1100100001',
        relevant: true,
      }],
    })
    assert.doesNotMatch(body, /Private patient|Private transcript|Provider response|diagnostic detail/)

    let derivedPatientResponse = await router.fetch(new Request(
      'http://localhost' + routes.resources.processingAll.href()
        + '?path=' + encodeURIComponent(routes.workspace.patient.href({
          shiftId: 'shift-1',
          patientKey: 'private-patient-name-private-bed',
        })),
      { headers: { cookie, accept: 'application/json' } },
    ))
    let derivedPatientPayload = JSON.parse(await derivedPatientResponse.text())
    assert.equal(derivedPatientPayload.items[0]?.relevant, true)

    let unrelatedPatientResponse = await router.fetch(new Request(
      'http://localhost' + routes.resources.processingAll.href()
        + '?path=' + encodeURIComponent(routes.workspace.patient.href({
          shiftId: 'shift-1',
          patientKey: 'another-patient',
        })),
      { headers: { cookie, accept: 'application/json' } },
    ))
    let unrelatedPayload = JSON.parse(await unrelatedPatientResponse.text())
    assert.equal(unrelatedPayload.items[0]?.relevant, false)
  })
})

describe('processing event stream resource', () => {
  it('streams only authorised processing wake signals and closes its subscription', async () => {
    let f = fixture()
    let router = createAppRouter({
      data: f.runtime,
      sessionStorage: f.storage,
      sessionCookie: f.cookie,
      processingEvents: f.processingEvents,
    })
    let cookie = await authenticatedCookie(f)
    let response = await router.fetch(new Request(
      'http://localhost' + routes.resources.processingEvents.href(),
      { headers: { cookie, accept: 'text/event-stream' } },
    ))

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    assert.match(response.headers.get('cache-control') ?? '', /no-store|no-cache/)
    let reader = response.body!.getReader()
    let decoder = new TextDecoder()
    let ready = decoder.decode((await reader.read()).value)
    assert.match(ready, /event: ready/)
    assert.doesNotMatch(ready, /Private patient|Private transcript|diagnostic detail/)

    let next = reader.read()
    f.processingEvents.emit('handover-1')
    let processing = decoder.decode((await next).value)
    assert.match(processing, /event: processing/)
    assert.match(processing, /"id":"handover-1"/)
    assert.doesNotMatch(processing, /Private patient|Private transcript|diagnostic detail/)

    await reader.cancel()
  })

  it('rejects an unauthenticated event stream before opening it', async () => {
    let f = fixture()
    let router = createAppRouter({
      data: f.runtime,
      sessionStorage: f.storage,
      sessionCookie: f.cookie,
      processingEvents: f.processingEvents,
    })
    let response = await router.fetch(new Request(
      'http://localhost' + routes.resources.processingEvents.href(),
      { headers: { accept: 'text/event-stream' } },
    ))
    assert.equal(response.status, 401)
  })
})
