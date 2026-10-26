import * as assert from 'remix/assert'
import { createCookie } from 'remix/cookie'
import { createSession } from 'remix/session'
import { createMemorySessionStorage } from 'remix/session-storage/memory'
import { describe, it } from 'remix/test'

import { createAppRouter } from '../../app/router.ts'
import { routes } from '../../app/routes.ts'

describe('workspace query budget', () => {
  it('keeps the document plus Frame query count constant from one to twenty shifts', async () => {
    let one = await renderShiftSelection(1)
    let twenty = await renderShiftSelection(20)

    assert.equal(one.status, 200)
    assert.equal(twenty.status, 200)
    assert.equal(twenty.queryCount, one.queryCount)
  })

  it('does not execute the shift leaf read before the workspace Frame request', async () => {
    let f = fixture(1)
    let cookie = await authenticatedCookie(f)
    let response = await f.router.fetch(new Request(`http://localhost${routes.workspace.shift.href({ shiftId: 'shift-1' })}`, {
      headers: { cookie },
    }))
    await response.text()

    assert.equal(response.status, 200)
    assert.equal(f.targetShiftReads(), 1)
  })
})

async function renderShiftSelection(shiftCount: number) {
  let f = fixture(shiftCount)
  let cookie = await authenticatedCookie(f)
  let response = await f.router.fetch(new Request(`http://localhost${routes.workspace.shiftSelection.href()}`, {
    headers: { cookie },
  }))
  await response.text()
  return { status: response.status, queryCount: f.queryCount() }
}

function fixture(shiftCount: number) {
  let now = new Date('2026-07-14T00:00:00.000Z')
  let user = {
    id: 'user-1', full_name: 'Avery Clinician', occupation: 'Nurse', department: 'Medicine',
    created_at: now, updated_at: now, last_active_at: now,
  }
  let shiftRows = Array.from({ length: shiftCount }, (_, index) => ({
    id: `shift-${index + 1}`, created_by_user_id: user.id, title: `Shift ${index + 1}`,
    department: 'Medicine', assigned_user_ids: [], notes: '', patient_order: [],
    created_at: now, updated_at: now,
  }))
  let queryCount = 0
  let targetShiftReads = 0
  let db = {
    async find(_table: unknown, id: string) { queryCount++; return id === user.id ? user : null },
    async findMany() { queryCount++; return [] },
    async exec(query: { text?: string; values?: unknown[] }) {
      queryCount++
      let text = query.text ?? ''
      if (text.includes('select * from shifts where id = ?')) {
        targetShiftReads++
        return { rows: shiftRows.filter((shift) => shift.id === query.values?.[0]) }
      }
      if (text.includes('select * from shifts') && !text.includes('where id = ?')) return { rows: shiftRows }
      return { rows: [] }
    },
  }
  let runtime = { db, pool: {}, async ready() {}, async close() {} }
  let storage = createMemorySessionStorage()
  let sessionCookie = createCookie('test-handover-session', { secrets: ['test-session-secret'], httpOnly: true, sameSite: 'Lax', path: '/' })
  let router = createAppRouter({ data: runtime as never, sessionStorage: storage, sessionCookie })
  return { router, storage, sessionCookie, queryCount: () => queryCount, targetShiftReads: () => targetShiftReads }
}

async function authenticatedCookie(f: ReturnType<typeof fixture>) {
  let session = createSession()
  session.set('auth', { userId: 'user-1' })
  let id = await f.storage.save(session)
  assert.ok(id)
  return f.sessionCookie.serialize(id)
}
