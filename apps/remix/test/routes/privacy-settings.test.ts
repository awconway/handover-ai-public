import * as assert from 'remix/assert'
import { createCookie } from 'remix/cookie'
import type { SqlStatement } from 'remix/data-table'
import { createSession } from 'remix/session'
import { createMemorySessionStorage } from 'remix/session-storage/memory'
import { describe, it } from 'remix/test'

import { createAppRouter } from '../../app/router.ts'
import { routes } from '../../app/routes.ts'

function staffUser(id: string, enabled = false) {
  return {
    id,
    full_name: id === 'user-1' ? 'Avery Clinician' : 'Jordan Clinician',
    occupation: id === 'user-1' ? 'Nurse' : 'Administrator',
    department: 'General Medicine',
    local_first_processing_enabled: enabled,
    created_at: new Date(),
    updated_at: new Date(),
    last_active_at: new Date(),
  }
}

function fixture() {
  let users = new Map([
    ['user-1', staffUser('user-1')],
    ['user-2', staffUser('user-2', true)],
  ])
  let updates: Array<{ userId: string; enabled: boolean }> = []
  let db = {
    async find(_table: unknown, id: string) { return users.get(id) ?? null },
    async findMany() { return [] },
    async exec(statement: SqlStatement | string) {
      let text = typeof statement === 'string' ? statement : statement.text
      if (!/update users/i.test(text) || typeof statement === 'string') return { rows: [] }
      let [enabled, userId] = statement.values as [boolean, string]
      let existing = users.get(userId)
      if (!existing) return { rows: [] }
      updates.push({ userId, enabled })
      users.set(userId, { ...existing, local_first_processing_enabled: enabled, updated_at: new Date() })
      return { rows: [{ local_first_processing_enabled: enabled }] }
    },
  }
  let runtime = { db, pool: {}, async ready() {}, async close() {} }
  let storage = createMemorySessionStorage()
  let cookie = createCookie('test-handover-session', {
    secrets: ['test-session-secret'], httpOnly: true, sameSite: 'Lax', path: '/',
  })
  return { runtime: runtime as never, storage, cookie, users, updates }
}

async function authenticatedCookie(f: ReturnType<typeof fixture>, userId = 'user-1') {
  let session = createSession()
  session.set('auth', { userId })
  let id = await f.storage.save(session)
  assert.ok(id)
  return f.cookie.serialize(id)
}

async function withPolicy<T>(policy: string, operation: () => Promise<T>): Promise<T> {
  let previous = process.env.LOCAL_FIRST_PROCESSING_POLICY
  process.env.LOCAL_FIRST_PROCESSING_POLICY = policy
  try {
    return await operation()
  } finally {
    if (previous == null) delete process.env.LOCAL_FIRST_PROCESSING_POLICY
    else process.env.LOCAL_FIRST_PROCESSING_POLICY = previous
  }
}

describe('privacy settings route', () => {
  it('requires authentication for the settings document', async () => {
    await withPolicy('optional', async () => {
      let f = fixture()
      let router = createAppRouter({
        data: f.runtime,
        sessionStorage: f.storage,
        sessionCookie: f.cookie,
        publicOrigins: ['http://localhost'],
      })

      let response = await router.fetch(new Request(
        'http://localhost' + routes.settings.privacy.index.href(),
      ))

      assert.equal(response.status, 303)
      assert.ok(response.headers.get('location')?.startsWith(routes.auth.signIn.index.href()))
    })
  })

  it('renders and updates the authenticated user preference with CSRF protection', async () => {
    await withPolicy('optional', async () => {
      let f = fixture()
      let router = createAppRouter({
        data: f.runtime,
        sessionStorage: f.storage,
        sessionCookie: f.cookie,
        publicOrigins: ['http://localhost'],
      })
      let initialCookie = await authenticatedCookie(f)
      let page = await router.fetch(new Request(
        'http://localhost' + routes.settings.privacy.index.href(),
        { headers: { cookie: initialCookie } },
      ))
      assert.equal(page.status, 200)
      let html = await page.text()
      assert.match(html, /Audio privacy/)
      assert.match(html, /Your choice/)
      assert.match(html, /Audio is always transcribed locally/)
      assert.match(html, /Deidentify before cloud analysis/)
      assert.match(html, /Changes apply to future jobs/)
      assert.match(html, /role="switch"/)
      assert.doesNotMatch(html, /role="switch"(?:(?!>).)*\sdisabled(?:=""|(?=\s|>))/)

      let token = html.match(/name="_csrf" value="([^"]+)"/)?.[1]
      assert.ok(token)
      let activeCookie = page.headers.get('set-cookie')?.split(';', 1)[0] ?? initialCookie

      let rejectedBody = new FormData()
      rejectedBody.set('enabled', 'true')
      let rejected = await router.fetch(new Request(
        'http://localhost' + routes.settings.privacy.action.href(),
        { method: 'POST', headers: { cookie: activeCookie, origin: 'http://localhost' }, body: rejectedBody },
      ))
      assert.equal(rejected.status, 403)
      assert.equal(f.updates.length, 0)

      let body = new FormData()
      body.set('_csrf', token)
      body.set('enabled', 'true')
      let saved = await router.fetch(new Request(
        'http://localhost' + routes.settings.privacy.action.href(),
        { method: 'POST', headers: { cookie: activeCookie, origin: 'http://localhost' }, body },
      ))

      assert.equal(saved.status, 303)
      assert.equal(saved.headers.get('location'), routes.settings.privacy.index.href())
      assert.deepEqual(f.updates, [{ userId: 'user-1', enabled: true }])
      assert.equal(f.users.get('user-1')?.local_first_processing_enabled, true)
      assert.equal(f.users.get('user-2')?.local_first_processing_enabled, true)
    })
  })

  it('shows deployment-required mode but rejects attempts to edit it', async () => {
    await withPolicy('required', async () => {
      let f = fixture()
      let router = createAppRouter({
        data: f.runtime,
        sessionStorage: f.storage,
        sessionCookie: f.cookie,
        publicOrigins: ['http://localhost'],
      })
      let initialCookie = await authenticatedCookie(f)
      let page = await router.fetch(new Request(
        'http://localhost' + routes.settings.privacy.index.href(),
        { headers: { cookie: initialCookie } },
      ))
      let html = await page.text()
      assert.match(html, /Required by deployment/)
      assert.match(html, /Deidentification on/)
      assert.match(html, /role="switch"(?:(?!>).)*\sdisabled(?:=""|(?=\s|>))/)
      let token = html.match(/name="_csrf" value="([^"]+)"/)?.[1]
      assert.ok(token)
      let activeCookie = page.headers.get('set-cookie')?.split(';', 1)[0] ?? initialCookie
      let body = new FormData()
      body.set('_csrf', token)
      body.set('enabled', 'false')

      let response = await router.fetch(new Request(
        'http://localhost' + routes.settings.privacy.action.href(),
        { method: 'POST', headers: { cookie: activeCookie, origin: 'http://localhost' }, body },
      ))

      assert.equal(response.status, 409)
      assert.equal(f.updates.length, 0)
    })
  })
})
