import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import * as assert from 'remix/assert'
import { createCookie } from 'remix/cookie'
import { sql } from 'remix/data-table'
import { createSession } from 'remix/session'
import { createMemorySessionStorage } from 'remix/session-storage/memory'
import { describe, it } from 'remix/test'

import {
  createAssignment,
  createDataRuntime,
  listHandoversForUser,
  type DataRuntime,
  type UploadStorage,
} from '../../app/data/index.ts'
import { createAppRouter } from '../../app/router.ts'
import { routes } from '../../app/routes.ts'

type Actor = { id: string; cookie: string; csrf: string }

function recordingStorage(deleted: string[], options: { failDelete?: boolean } = {}): UploadStorage {
  return {
    async put() { throw new Error('Unexpected upload') },
    async getStream() { return Readable.from([]) },
    async delete(key) {
      deleted.push(key)
      if (options.failDelete) throw new Error('Temporary object storage failure')
      return true
    },
    async healthCheck() {},
  }
}

async function actor(
  router: ReturnType<typeof createAppRouter>,
  sessions: ReturnType<typeof createMemorySessionStorage>,
  cookie: ReturnType<typeof createCookie>,
  userId: string,
): Promise<Actor> {
  let session = createSession()
  session.set('auth', { userId })
  let sessionId = await sessions.save(session)
  assert.ok(sessionId)
  let initialCookie = await cookie.serialize(sessionId)
  let page = await router.fetch(new Request('http://localhost/', { headers: { cookie: initialCookie } }))
  let csrf = (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1]
  assert.ok(csrf)
  return {
    id: userId,
    csrf,
    cookie: page.headers.get('set-cookie')?.split(';', 1)[0] ?? initialCookie,
  }
}

async function post(actor: Actor, router: ReturnType<typeof createAppRouter>, href: string, values: Record<string, string> = {}) {
  let body = new FormData()
  body.set('_csrf', actor.csrf)
  for (let [key, value] of Object.entries(values)) body.set(key, value)
  return router.fetch(new Request('http://localhost' + href, {
    method: 'POST',
    headers: { cookie: actor.cookie, origin: 'http://localhost' },
    body,
  }))
}

async function seed(runtime: DataRuntime) {
  let sender = randomUUID()
  let recipient = randomUUID()
  let handover = randomUUID()
  let shift = randomUUID()
  for (let id of [sender, recipient]) {
    await runtime.db.exec(sql`
      insert into users(id, full_name, occupation, department)
      values(${id}, ${id}, 'Registered Nurse', 'Ward A')
    `)
  }
  await runtime.db.exec(sql`
    insert into shifts(id, created_by_user_id, title, department, assigned_user_ids)
    values(${shift}, ${recipient}, 'Day shift', 'Ward A', ${JSON.stringify([recipient])}::jsonb)
  `)
  await runtime.db.exec(sql`
    insert into handovers(
      id, created_by_user_id, title, direction, source_department, context_type,
      consent_mode, priority_preference, processing_status
    ) values(
      ${handover}, ${sender}, 'Source handover', 'outgoing', 'Ward A',
      'shift-handover', 'agreed', 'balanced', 'completed'
    )
  `)
  let assignment = await createAssignment(runtime.db, {
    id: randomUUID(),
    handoverId: handover,
    assignedByUserId: sender,
    assignedToUserId: recipient,
  })
  assert.ok(assignment)
  return { sender, recipient, handover, shift, assignment }
}

async function cleanup(runtime: DataRuntime, ids: { sender: string; recipient: string }) {
  await runtime.db.exec(sql`delete from users where id in (${ids.sender}, ${ids.recipient})`)
}

describe('assignment lifecycle routes', () => {
  it('supports pending -> individual -> placed and keeps both mutations idempotent', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let seeded = await seed(runtime)
    let sessions = createMemorySessionStorage()
    let cookie = createCookie('assignment-lifecycle', { secrets: ['test-secret'], path: '/', httpOnly: true })
    let storage = recordingStorage([])
    let router = createAppRouter({
      data: runtime,
      sessionStorage: sessions,
      sessionCookie: cookie,
      publicOrigins: ['http://localhost'],
      audioStorage: storage,
      sheetStorage: storage,
    })
    try {
      let recipient = await actor(router, sessions, cookie, seeded.recipient)
      let individualHref = routes.actions.addAssignmentToIndividual.href({ assignmentId: seeded.assignment.id })
      for (let attempt = 0; attempt < 2; attempt++) {
        let response = await post(recipient, router, individualHref)
        assert.equal(response.status, 303)
        assert.equal(response.headers.get('location'), routes.workspace.individual.href())
      }

      let individual = (await runtime.db.exec(sql`
        select a.status, a.target_shift_id, h.shared_with_user_ids
        from handover_assignments a join handovers h on h.id = a.handover_id
        where a.id = ${seeded.assignment.id}
      `)).rows![0]!
      assert.equal(individual.status, 'individual')
      assert.equal(individual.target_shift_id, null)
      assert.deepEqual(individual.shared_with_user_ids, [seeded.recipient])

      let placeHref = routes.actions.placeAssignment.href({ assignmentId: seeded.assignment.id })
      for (let attempt = 0; attempt < 2; attempt++) {
        let response = await post(recipient, router, placeHref, { shiftId: seeded.shift })
        assert.equal(response.status, 303)
        assert.equal(response.headers.get('location'), routes.workspace.shift.href({ shiftId: seeded.shift }))
      }

      let placed = (await runtime.db.exec(sql`
        select a.status, a.target_shift_id, h.shift_id, h.shared_with_user_ids
        from handover_assignments a join handovers h on h.id = a.handover_id
        where a.id = ${seeded.assignment.id}
      `)).rows![0]!
      assert.equal(placed.status, 'placed')
      assert.equal(placed.target_shift_id, seeded.shift)
      assert.equal(placed.shift_id, seeded.shift)
      assert.deepEqual(placed.shared_with_user_ids, [seeded.recipient])

      assert.equal((await post(recipient, router, individualHref)).status, 404)
      assert.equal((await post(recipient, router, routes.actions.dismissAssignment.href({ assignmentId: seeded.assignment.id }))).status, 404)

      let directSource = randomUUID()
      await runtime.db.exec(sql`
        insert into handovers(
          id, created_by_user_id, title, direction, source_department, context_type,
          consent_mode, priority_preference, processing_status
        ) values(
          ${directSource}, ${seeded.sender}, 'Direct placement', 'outgoing', 'Ward A',
          'shift-handover', 'agreed', 'balanced', 'completed'
        )
      `)
      let direct = await createAssignment(runtime.db, {
        id: randomUUID(), handoverId: directSource,
        assignedByUserId: seeded.sender, assignedToUserId: seeded.recipient,
      })
      assert.ok(direct)
      let directResponse = await post(
        recipient,
        router,
        routes.actions.placeAssignment.href({ assignmentId: direct.id }),
        { shiftId: seeded.shift },
      )
      assert.equal(directResponse.status, 303)
      assert.equal((await runtime.db.exec(sql`
        select status from handover_assignments where id = ${direct.id}
      `)).rows![0]!.status, 'placed')
    } finally {
      await cleanup(runtime, seeded)
      await runtime.close()
    }
  })

  it('commits recipient dismissal with durable cleanup without awaiting object storage', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let seeded = await seed(runtime)
    let audioKey = `${randomUUID()}.webm`
    let exceptionId = randomUUID()
    await runtime.db.exec(sql`
      insert into local_privacy_exceptions(
        id,handover_family_id,normalized_text,canonical_label,
        source_handover_id,source_original_text,created_by_user_id
      ) values(
        ${exceptionId},${seeded.handover},'Bill','PERSON',${seeded.handover},'Bill',${seeded.sender}
      )
    `)
    await runtime.db.exec(sql`delete from handovers where id=${seeded.handover}`)
    assert.equal((await runtime.db.exec(sql`
      select count(*)::int count from local_privacy_exceptions where id=${exceptionId}
    `)).rows?.[0]?.count, 1)
    await runtime.db.exec(sql`
      update handovers set audio_blob_key = ${audioKey}, audio_content_type = 'audio/webm',
        audio_original_filename = 'copy.webm', audio_size_bytes = 128
      where id = ${seeded.assignment.handover_id}
    `)
    await runtime.db.exec(sql`
      insert into handover_audio(id, handover_id, revision, purpose, blob_key, content_type, original_filename, size_bytes)
      values(${randomUUID()}, ${seeded.assignment.handover_id}, 1, 'initial', ${audioKey}, 'audio/webm', 'copy.webm', 128)
    `)

    let deleted: string[] = []
    let storage = recordingStorage(deleted, { failDelete: true })
    let sessions = createMemorySessionStorage()
    let cookie = createCookie('assignment-dismissal', { secrets: ['test-secret'], path: '/', httpOnly: true })
    let router = createAppRouter({
      data: runtime,
      sessionStorage: sessions,
      sessionCookie: cookie,
      publicOrigins: ['http://localhost'],
      audioStorage: storage,
      sheetStorage: storage,
    })
    try {
      let href = routes.actions.dismissAssignment.href({ assignmentId: seeded.assignment.id })
      let sender = await actor(router, sessions, cookie, seeded.sender)
      assert.equal((await post(sender, router, href)).status, 404)
      assert.ok((await runtime.db.exec(sql`select id from handovers where id = ${seeded.assignment.handover_id}`)).rows?.[0])

      let recipient = await actor(router, sessions, cookie, seeded.recipient)
      let response = await post(recipient, router, href)
      assert.equal(response.status, 303)
      assert.equal(response.headers.get('location'), routes.workspace.inbox.href())
      assert.equal((await runtime.db.exec(sql`select count(*)::int count from handovers where id = ${seeded.assignment.handover_id}`)).rows![0]!.count, 0)
      assert.equal((await runtime.db.exec(sql`select count(*)::int count from handover_assignments where id = ${seeded.assignment.id}`)).rows![0]!.count, 0)
      assert.equal((await listHandoversForUser(runtime.db, seeded.recipient)).some((row) => row.id === seeded.assignment.handover_id), false)
      assert.deepEqual(deleted, [])
      let cleanup = (await runtime.db.exec(sql`
        select kind, blob_key, handover_id, status from resource_cleanup_outbox
        where handover_id = ${seeded.assignment.handover_id}
      `)).rows
      assert.deepEqual(cleanup, [{
        kind: 'local-audio-object', blob_key: audioKey,
        handover_id: seeded.assignment.handover_id, status: 'queued',
      }])
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int count from local_privacy_exceptions where id=${exceptionId}
      `)).rows?.[0]?.count, 0)
    } finally {
      await runtime.db.exec(sql`delete from resource_cleanup_outbox where handover_id = ${seeded.assignment.handover_id}`)
      await runtime.db.exec(sql`delete from local_privacy_exceptions where id=${exceptionId}`)
      await cleanup(runtime, seeded)
      await runtime.close()
    }
  })
})
