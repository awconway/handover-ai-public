import * as assert from 'remix/assert'
import { createCookie } from 'remix/cookie'
import { createSession } from 'remix/session'
import { createMemorySessionStorage } from 'remix/session-storage/memory'
import { describe, it } from 'remix/test'

import { createAppRouter } from '../../app/router.ts'
import { normalizePatientWorkspaceTab, normalizeReviewTab, routes } from '../../app/routes.ts'

function fixture() {
  let user = {
    id: 'user-1', full_name: 'Avery Clinician', occupation: 'Nurse', department: 'General Medicine',
    created_at: new Date(), updated_at: new Date(), last_active_at: new Date(),
  }
  let db = {
    async find(_table: unknown, id: string) { return id === user.id ? user : null },
    async findMany() { return [] },
    async exec() { return { rows: [] } },
    async create(_table: unknown, value: Record<string, unknown>) { return { ...value, id: 'shift-1', created_at: new Date(), updated_at: new Date() } },
  }
  let runtime = { db, pool: {}, async ready() {}, async close() {} }
  let storage = createMemorySessionStorage()
  let cookie = createCookie('test-handover-session', { secrets: ['test-session-secret'], httpOnly: true, sameSite: 'Lax', path: '/' })
  return { runtime: runtime as never, storage, cookie, user }
}

async function authenticatedCookie(f: ReturnType<typeof fixture>) {
  let session = createSession()
  session.set('auth', { userId: 'user-1' })
  let id = await f.storage.save(session)
  assert.ok(id)
  return await f.cookie.serialize(id)
}

describe('native Remix HTTP boundary', () => {
  it('keeps operational health public and rejects legacy session headers', async () => {
    let f = fixture()
    let router = createAppRouter({ data: f.runtime, sessionStorage: f.storage, sessionCookie: f.cookie })
    let healthy = await router.fetch(new Request('http://localhost' + routes.health.href()))
    assert.equal(healthy.status, 200)
    assert.equal(healthy.headers.get('cache-control'), 'private, no-store')
    assert.ok((healthy.headers.get('vary') ?? '').toLowerCase().split(',').map((name) => name.trim()).includes('cookie'))

    let legacy = await router.fetch(new Request('http://localhost' + routes.health.href(), { headers: { 'x-session-id': 'legacy' } }))
    assert.equal(legacy.status, 400)
  })

  it('does not disclose infrastructure errors from public readiness routes', async () => {
    let f = fixture()
    ;(f.runtime as any).ready = async () => { throw new Error('postgres://secret-user:secret-password@database/internal') }
    let router = createAppRouter({ data: f.runtime, sessionStorage: f.storage, sessionCookie: f.cookie })

    let response = await router.fetch(new Request('http://localhost' + routes.ready.href()))

    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { ok: false, error: 'Readiness check failed' })
  })

  it('redirects anonymous document requests to the native sign-in route', async () => {
    let f = fixture()
    let router = createAppRouter({ data: f.runtime, sessionStorage: f.storage, sessionCookie: f.cookie })
    let response = await router.fetch(new Request('http://localhost' + routes.workspace.individual.href()))
    assert.equal(response.status, 303)
    assert.ok(
      response.headers.get('location')?.startsWith(
        routes.auth.signIn.index.href() + '?returnTo=',
      ),
    )
  })

  it('accepts form submissions from the supported local loopback alias', async () => {
    let f = fixture()
    let router = createAppRouter({ data: f.runtime, sessionStorage: f.storage, sessionCookie: f.cookie })
    let origin = 'http://127.0.0.1:8787'
    let page = await router.fetch(new Request(origin + routes.auth.signIn.index.href()))
    assert.equal(page.status, 200)
    let token = (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1]
    assert.ok(token)
    let cookie = page.headers.get('set-cookie')?.split(';', 1)[0]
    assert.ok(cookie)

    let body = new FormData()
    body.set('_csrf', token)
    body.set('userId', f.user.id)
    let response = await router.fetch(new Request(origin + routes.auth.signIn.action.href(), {
      method: 'POST',
      headers: { cookie, origin },
      body,
    }))

    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), routes.workspace.home.href())
  })

  it('preserves the requested workspace destination in the sign-in form action', async () => {
    let f = fixture()
    ;(f.runtime as any).db.findMany = async () => [f.user]
    let router = createAppRouter({ data: f.runtime, sessionStorage: f.storage, sessionCookie: f.cookie })
    let returnTo = routes.workspace.shift.href({ shiftId: 'one' }) + '?tab=actions'
    let response = await router.fetch(new Request(
      'http://localhost' + routes.auth.signIn.index.href() + '?returnTo=' + encodeURIComponent(returnTo),
    ))
    assert.equal(response.status, 200)
    let html = await response.text()
    let encodedReturnTo = encodeURIComponent(returnTo)
    assert.ok(html.includes(`action="${routes.auth.signIn.index.href()}?returnTo=${encodedReturnTo}"`))
    assert.ok(html.includes(`action="${routes.auth.register.index.href()}?returnTo=${encodedReturnTo}"`))
  })

  it('renders the authenticated top header and route-aware workspace trail', async () => {
    let f = fixture()
    let router = createAppRouter({ data: f.runtime, sessionStorage: f.storage, sessionCookie: f.cookie })
    let cookie = await authenticatedCookie(f)
    let response = await router.fetch(new Request('http://localhost' + routes.workspace.individual.href(), {
      headers: { cookie },
    }))
    assert.equal(response.status, 200)
    let html = await response.text()
    assert.match(html, /Individual mode/)
    assert.match(html, /aria-label="Inbox, 0 unactioned items"/)
    assert.ok(html.includes(`action="${routes.auth.signOut.href()}"`))
    assert.match(html, /name="_csrf"/)
    assert.match(html, /Back to workflow home/)
    assert.match(html, /aria-current="page"[^>]*>Handovers</)
    assert.doesNotMatch(html, /aria-label="Workspace navigation"/)
  })

  it('rotates CSRF state through HTML and persists a form mutation', async () => {
    let f = fixture()
    let router = createAppRouter({ data: f.runtime, sessionStorage: f.storage, sessionCookie: f.cookie, publicOrigins: ['http://localhost'] })
    let initialCookie = await authenticatedCookie(f)
    let page = await router.fetch(new Request(
      'http://localhost' + routes.workspace.home.href(),
      { headers: { cookie: initialCookie } },
    ))
    assert.equal(page.status, 200)
    let html = await page.text()
    let token = html.match(/name="_csrf" value="([^"]+)"/)?.[1]
    assert.ok(token)
    let responseCookie = page.headers.get('set-cookie')?.split(';', 1)[0] ?? initialCookie

    let body = new FormData()
    body.set('_csrf', token)
    body.set('title', 'Evening ward cover')
    body.set('department', 'General Medicine')
    let response = await router.fetch(new Request('http://localhost' + routes.actions.createShift.href(), {
      method: 'POST', headers: { cookie: responseCookie, origin: 'http://localhost' }, body,
    }))
    assert.equal(response.status, 303)
    assert.equal(
      response.headers.get('location'),
      routes.workspace.shift.href({ shiftId: 'shift-1' }),
    )
  })

  it('returns invalid browser form navigations to their workspace with persistent inline feedback', async () => {
    let f = fixture()
    let router = createAppRouter({ data: f.runtime, sessionStorage: f.storage, sessionCookie: f.cookie, publicOrigins: ['http://localhost'] })
    let initialCookie = await authenticatedCookie(f)
    let shiftSelectionHref = routes.workspace.shiftSelection.href()
    let page = await router.fetch(new Request('http://localhost' + shiftSelectionHref, { headers: { cookie: initialCookie } }))
    let token = (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1]
    assert.ok(token)
    let activeCookie = page.headers.get('set-cookie')?.split(';', 1)[0] ?? initialCookie
    let body = new FormData()
    body.set('_csrf', token)
    body.set('title', 'x')
    body.set('department', '')

    let failed = await router.fetch(new Request('http://localhost' + routes.actions.createShift.href(), {
      method: 'POST',
      headers: {
        accept: 'text/html',
        cookie: activeCookie,
        origin: 'http://localhost',
        referer: 'http://localhost' + shiftSelectionHref,
        'sec-fetch-mode': 'navigate',
      },
      body,
    }))
    assert.equal(failed.status, 303)
    assert.equal(failed.headers.get('location'), shiftSelectionHref)

    let flashCookie = failed.headers.get('set-cookie')?.split(';', 1)[0] ?? activeCookie
    let returned = await router.fetch(new Request('http://localhost' + shiftSelectionHref, { headers: { cookie: flashCookie } }))
    assert.equal(returned.status, 200)
    let html = await returned.text()
    assert.match(html, /data-testid="page-error"/)
    assert.match(html, /Enter a shift name and department\./)
  })

  it('normalizes only supported review and patient tabs', () => {
    assert.equal(normalizeReviewTab('actions'), 'tasks')
    assert.equal(normalizeReviewTab('sbar'), 'summary')
    assert.equal(normalizeReviewTab('history'), null)
    assert.equal(normalizeReviewTab('unknown'), null)
    assert.equal(normalizePatientWorkspaceTab('handover-sheet'), 'handover-sheet')
    assert.equal(normalizePatientWorkspaceTab('unknown'), null)
  })

  it('returns only the requested workspace fragment for Frame navigation', async () => {
    let f = fixture()
    let router = createAppRouter({ data: f.runtime, sessionStorage: f.storage, sessionCookie: f.cookie })
    let cookie = await authenticatedCookie(f)
    let response = await router.fetch(new Request('http://localhost' + routes.workspace.individual.href(), {
      headers: { cookie, 'x-remix-target': 'workspace' },
    }))
    assert.equal(response.status, 200)
    let html = await response.text()
    assert.match(html, /Previous handovers/)
    assert.doesNotMatch(html, /<html/)
  })

  it('keeps pending inbox copies out of Previous handovers while showing individual copies', async () => {
    let f = fixture()
    let now = new Date('2026-07-13T04:30:00.000Z')
    let handover = (id: string, title: string) => ({
      id,
      created_by_user_id: 'user-1',
      source_handover_id: 'source-' + id,
      shift_id: null,
      source_shift_id: null,
      title,
      direction: 'incoming',
      source_department: 'Ward A',
      destination_department: '',
      context_type: 'short-transfer',
      linked_patient_key: null,
      linked_patient_display_name: null,
      linked_patient_location: null,
      participants: [],
      shared_with_user_ids: [],
      consent_mode: 'agreed',
      priority_preference: 'balanced',
      notes: '',
      transcript: '',
      transcription_metadata: null,
      analysis: null,
      processing_status: 'completed',
      processing_started_at: now,
      error_message: null,
      version: 1,
      created_at: now,
      updated_at: now,
    })
    let rows = [handover('handover-pending', 'Pending inbox copy'), handover('handover-individual', 'Individual copy')]
    let assignments = [
      { id: 'assignment-pending', handover_id: 'handover-pending', assigned_by_user_id: 'sender', assigned_to_user_id: 'user-1', status: 'pending', target_shift_id: null, assigned_at: now, placed_at: null, updated_at: now },
      { id: 'assignment-individual', handover_id: 'handover-individual', assigned_by_user_id: 'sender', assigned_to_user_id: 'user-1', status: 'individual', target_shift_id: null, assigned_at: now, placed_at: now, updated_at: now },
    ]
    ;(f.runtime as any).db.exec = async (query: { text?: string }) => {
      return { rows: query.text?.includes('select distinct h.* from handovers h') ? rows : [] }
    }
    ;(f.runtime as any).db.findMany = async (_table: unknown, options: any) => {
      if (options?.where?.assigned_to_user_id) {
        return assignments.filter((assignment) => assignment.assigned_to_user_id === options.where.assigned_to_user_id && assignment.status === options.where.status)
      }
      return []
    }

    let router = createAppRouter({ data: f.runtime, sessionStorage: f.storage, sessionCookie: f.cookie })
    let cookie = await authenticatedCookie(f)
    let response = await router.fetch(new Request('http://localhost' + routes.workspace.individual.href(), { headers: { cookie } }))
    assert.equal(response.status, 200)
    let html = await response.text()
    assert.match(html, /Individual copy/)
    assert.doesNotMatch(html, /Pending inbox copy/)
    assert.match(html, /aria-label="Inbox, 1 unactioned item"/)
  })

  it('omits the collector and performs no analytics writes when analytics is disabled', async () => {
    let previous = process.env.USABILITY_ANALYTICS_ENABLED
    process.env.USABILITY_ANALYTICS_ENABLED = 'false'
    try {
      let f = fixture()
      let router = createAppRouter({ data: f.runtime, sessionStorage: f.storage, sessionCookie: f.cookie, publicOrigins: ['http://localhost'] })
      let initialCookie = await authenticatedCookie(f)
      let page = await router.fetch(new Request(
        'http://localhost' + routes.workspace.home.href(),
        { headers: { cookie: initialCookie } },
      ))
      let html = await page.text()
      assert.equal(html.includes(routes.resources.analytics.href()), false)
      let token = html.match(/name="_csrf" value="([^"]+)"/)?.[1]
      assert.ok(token)
      let cookie = page.headers.get('set-cookie')?.split(';', 1)[0] ?? initialCookie
      let body = new FormData()
      body.set('_csrf', token)
      body.set('events', JSON.stringify([{ type: 'route_duration', route: '/shift/private/patients/Patient-Name' }]))
      let response = await router.fetch(new Request('http://localhost' + routes.resources.analytics.href(), {
        method: 'POST', headers: { cookie, origin: 'http://localhost' }, body,
      }))
      assert.equal(response.status, 204)
    } finally {
      if (previous == null) delete process.env.USABILITY_ANALYTICS_ENABLED
      else process.env.USABILITY_ANALYTICS_ENABLED = previous
    }
  })
})
