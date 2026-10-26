import { randomUUID } from 'node:crypto'
import * as assert from 'remix/assert'
import { createCookie } from 'remix/cookie'
import { sql } from 'remix/data-table'
import { createSession } from 'remix/session'
import { createMemorySessionStorage } from 'remix/session-storage/memory'
import { describe, it } from 'remix/test'

import {
  createDataRuntime,
  createSuccessfulTranscriptionAudioRetention,
  PROVISIONAL_AUDIO_UPLOAD_JOB_PREFIX,
  type UploadInput,
  type UploadStorage,
} from '../../app/data/index.ts'
import { createAppRouter } from '../../app/router.ts'
import { routes } from '../../app/routes.ts'

function recordingStorage() {
  let stored: Array<{ key: string; input: UploadInput }> = []
  let writeBarrier: { remaining: number; promise: Promise<void>; release(): void } | null = null
  let storage: UploadStorage = {
    async put(input) {
      let key = `${randomUUID()}.webm`
      stored.push({ key, input })
      return { key, sizeBytes: input.bytes.length, contentType: input.contentType, originalFilename: input.filename }
    },
    async putFileAtKey(key, file) {
      let input = {
        bytes: Buffer.from(await file.arrayBuffer()),
        contentType: file.type,
        filename: file.name,
      }
      let existing = stored.find((item) => item.key === key)
      if (existing) assert.deepEqual(existing.input.bytes, input.bytes)
      else stored.push({ key, input })
      if (writeBarrier) {
        let barrier = writeBarrier
        barrier.remaining -= 1
        if (barrier.remaining === 0) barrier.release()
        await barrier.promise
      }
      return { key, sizeBytes: file.size, contentType: file.type, originalFilename: file.name }
    },
    async getStream() { throw new Error('not needed') },
    async delete(key) {
      let index = stored.findIndex((item) => item.key === key)
      if (index < 0) return false
      stored.splice(index, 1)
      return true
    },
    async healthCheck() {},
  }
  return {
    storage,
    stored,
    blockNextWrites(count: number) {
      let release!: () => void
      let promise = new Promise<void>((resolve) => { release = resolve })
      writeBarrier = { remaining: count, promise, release: () => { writeBarrier = null; release() } }
    },
  }
}

async function authenticatedBrowser(input: {
  router: ReturnType<typeof createAppRouter>
  sessions: ReturnType<typeof createMemorySessionStorage>
  cookie: ReturnType<typeof createCookie>
  userId: string
}) {
  let session = createSession()
  session.set('auth', { userId: input.userId })
  let sessionId = await input.sessions.save(session)
  assert.ok(sessionId)
  let initialCookie = await input.cookie.serialize(sessionId)
  let page = await input.router.fetch(new Request('http://localhost/', { headers: { cookie: initialCookie } }))
  let csrfToken = (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1]
  assert.ok(csrfToken)
  return {
    csrfToken,
    cookie: page.headers.get('set-cookie')?.split(';', 1)[0] ?? initialCookie,
  }
}

function createRecordingForm(
  csrfToken: string,
  recordingUploadId: string,
  title: string,
  audioBytes: BlobPart = 'same durable recording',
  filename = 'handover.webm',
) {
  let form = new FormData()
  form.set('_csrf', csrfToken)
  form.set('title', title)
  form.set('contextType', 'shift-handover')
  form.set('direction', 'incoming')
  form.set('sourceDepartment', 'Emergency')
  form.set('consentMode', 'agreed')
  form.set('recordingUploadId', recordingUploadId)
  form.set('audio', new File([audioBytes], filename, { type: 'audio/webm' }))
  return form
}

function extendRecordingForm(csrfToken: string, recordingUploadId: string) {
  let form = new FormData()
  form.set('_csrf', csrfToken)
  form.set('recordingUploadId', recordingUploadId)
  form.set('audio', new File([Buffer.from('same durable continuation')], 'continuation.webm', { type: 'audio/webm' }))
  return form
}

describe('durable recording upload idempotency', () => {
  it('replays duplicate creates per user without exposing another user result', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let firstUserId = randomUUID()
    let secondUserId = randomUUID()
    let recordingUploadId = randomUUID()
    let sessions = createMemorySessionStorage()
    let cookie = createCookie('recording-idempotency-session', { secrets: ['recording-idempotency-secret'], httpOnly: true, sameSite: 'Lax', path: '/' })
    let audio = recordingStorage()
    let cleanupIds: string[] = []
    let router = createAppRouter({
      data: runtime,
      sessionStorage: sessions,
      sessionCookie: cookie,
      audioStorage: audio.storage,
      publicOrigins: ['http://localhost'],
    })
    try {
      await runtime.db.exec(sql`
        insert into users(id, full_name, occupation, department) values
          (${firstUserId}, 'First Idempotency User', 'Nurse', 'Ward'),
          (${secondUserId}, 'Second Idempotency User', 'Nurse', 'Ward')
      `)
      let first = await authenticatedBrowser({ router, sessions, cookie, userId: firstUserId })
      let second = await authenticatedBrowser({ router, sessions, cookie, userId: secondUserId })

      let [firstResponse, replayResponse] = await Promise.all([
        router.fetch(new Request('http://localhost' + routes.actions.createHandover.href(), {
          method: 'POST', headers: { cookie: first.cookie, origin: 'http://localhost' },
          body: createRecordingForm(first.csrfToken, recordingUploadId, 'Durable create', 'same durable recording', 'retry.ogg'),
        })),
        router.fetch(new Request('http://localhost' + routes.actions.createHandover.href(), {
          method: 'POST', headers: { cookie: first.cookie, origin: 'http://localhost' },
          body: createRecordingForm(first.csrfToken, recordingUploadId, 'Durable create'),
        })),
      ])
      assert.equal(firstResponse.status, 303)
      assert.equal(replayResponse.status, 303)
      assert.equal(replayResponse.headers.get('location'), firstResponse.headers.get('location'))
      assert.equal(audio.stored.length, 1)

      let firstRows = (await runtime.db.exec(sql`
        select r.handover_id, r.job_id from handover_recording_uploads r
        where r.user_id = ${firstUserId} and r.recording_upload_id = ${recordingUploadId}::uuid
      `)).rows ?? []
      assert.equal(firstRows.length, 1)
      let firstJobs = (await runtime.db.exec(sql`
        select id, kind, revision, status, payload, created_at from handover_jobs where handover_id = ${String(firstRows[0]!.handover_id)}
      `)).rows ?? []
      assert.equal(firstJobs.length, 1)

      // Size and MIME type alone are not a request fingerprint: a delayed
      // retry with different bytes must conflict and its distinct object must
      // remain discoverable through the provisional cleanup outbox.
      let originalSize = Buffer.byteLength('same durable recording')
      let changedBytes = Buffer.alloc(originalSize, 0x78)
      let changedResponse = await router.fetch(new Request('http://localhost' + routes.actions.createHandover.href(), {
        method: 'POST', headers: { cookie: first.cookie, origin: 'http://localhost' },
        body: createRecordingForm(first.csrfToken, recordingUploadId, 'Durable create', changedBytes),
      }))
      assert.equal(changedResponse.status, 409)
      assert.equal(audio.stored.length, 1)

      // Force two first attempts with the same client UUID past preflight and
      // through deterministic storage before either clinical transaction can
      // commit. Exactly one wins; the differing audio bytes produce different
      // object keys and the losing key keeps durable cleanup intent.
      let racingUploadId = randomUUID()
      let racingSize = 32
      audio.blockNextWrites(2)
      let racingResponses = await Promise.all([
        router.fetch(new Request('http://localhost' + routes.actions.createHandover.href(), {
          method: 'POST', headers: { cookie: first.cookie, origin: 'http://localhost' },
          body: createRecordingForm(first.csrfToken, racingUploadId, 'Racing durable create', Buffer.alloc(racingSize, 0x61)),
        })),
        router.fetch(new Request('http://localhost' + routes.actions.createHandover.href(), {
          method: 'POST', headers: { cookie: first.cookie, origin: 'http://localhost' },
          body: createRecordingForm(first.csrfToken, racingUploadId, 'Racing durable create', Buffer.alloc(racingSize, 0x62)),
        })),
      ])
      assert.deepEqual(racingResponses.map((response) => response.status).sort(), [303, 409])
      assert.equal(audio.stored.length, 3)
      let racingKeys = audio.stored.slice(1).map((item) => item.key)
      let orphan = (await runtime.db.exec(sql`
        select id, blob_key from resource_cleanup_outbox
        where job_id like ${`${PROVISIONAL_AUDIO_UPLOAD_JOB_PREFIX}%`}
          and blob_key = any(${racingKeys}::text[])
      `)).rows?.[0]
      assert.ok(orphan)
      cleanupIds.push(String(orphan.id))
      await runtime.db.exec(sql`update resource_cleanup_outbox set next_retry_at = now() where id = ${String(orphan.id)}`)
      let cleanup = createSuccessfulTranscriptionAudioRetention({
        db: runtime.db,
        storage: audio.storage,
        env: { NODE_ENV: 'development', RETAIN_UPLOADED_AUDIO_AFTER_TRANSCRIPTION: 'true' },
      })
      let cleanupResult = await cleanup.processNext()
      assert.equal(cleanupResult.status, 'deleted')
      assert.equal(audio.stored.length, 2)

      // The UUID namespace is bound to the authenticated user. Reusing another
      // user's opaque key cannot return or mutate that user's result.
      let secondResponse = await router.fetch(new Request('http://localhost' + routes.actions.createHandover.href(), {
        method: 'POST', headers: { cookie: second.cookie, origin: 'http://localhost' },
        body: createRecordingForm(second.csrfToken, recordingUploadId, 'Second user create'),
      }))
      assert.equal(secondResponse.status, 303)
      assert.notEqual(secondResponse.headers.get('location'), firstResponse.headers.get('location'))
      let scopedRows = (await runtime.db.exec(sql`
        select user_id, handover_id from handover_recording_uploads
        where recording_upload_id = ${recordingUploadId}::uuid order by user_id
      `)).rows ?? []
      assert.equal(scopedRows.length, 2)
      assert.notEqual(scopedRows[0]!.handover_id, scopedRows[1]!.handover_id)
    } finally {
      if (cleanupIds.length) await runtime.db.exec(sql`delete from resource_cleanup_outbox where id = any(${cleanupIds}::text[])`)
      await runtime.db.exec(sql`delete from handover_recording_uploads where user_id in (${firstUserId}, ${secondUserId})`)
      await runtime.db.exec(sql`delete from handovers where created_by_user_id in (${firstUserId}, ${secondUserId})`)
      await runtime.db.exec(sql`delete from users where id in (${firstUserId}, ${secondUserId})`)
      await runtime.close()
    }
  })

  it("rejects reuse for another handover and rejects an unauthorized user's extension", async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let ownerId = randomUUID()
    let outsiderId = randomUUID()
    let firstHandoverId = randomUUID()
    let secondHandoverId = randomUUID()
    let recordingUploadId = randomUUID()
    let sessions = createMemorySessionStorage()
    let cookie = createCookie('recording-extension-session', { secrets: ['recording-extension-secret'], httpOnly: true, sameSite: 'Lax', path: '/' })
    let audio = recordingStorage()
    let router = createAppRouter({ data: runtime, sessionStorage: sessions, sessionCookie: cookie, audioStorage: audio.storage, publicOrigins: ['http://localhost'] })
    try {
      await runtime.db.exec(sql`
        insert into users(id, full_name, occupation, department) values
          (${ownerId}, 'Extension Owner', 'Nurse', 'Ward'),
          (${outsiderId}, 'Extension Outsider', 'Nurse', 'Ward')
      `)
      await runtime.db.exec(sql`
        insert into handovers(id, created_by_user_id, title, source_department, context_type, consent_mode, priority_preference)
        values
          (${firstHandoverId}, ${ownerId}, 'First extension target', 'Ward', 'shift-handover', 'agreed', 'balanced'),
          (${secondHandoverId}, ${ownerId}, 'Second extension target', 'Ward', 'shift-handover', 'agreed', 'balanced')
      `)
      let owner = await authenticatedBrowser({ router, sessions, cookie, userId: ownerId })
      let outsider = await authenticatedBrowser({ router, sessions, cookie, userId: outsiderId })

      let firstResponse = await router.fetch(new Request('http://localhost' + routes.actions.extendHandover.href({ handoverId: firstHandoverId }), {
        method: 'POST', headers: { cookie: owner.cookie, origin: 'http://localhost' },
        body: extendRecordingForm(owner.csrfToken, recordingUploadId),
      }))
      assert.equal(firstResponse.status, 303)

      let sameTargetReplay = await router.fetch(new Request('http://localhost' + routes.actions.extendHandover.href({ handoverId: firstHandoverId }), {
        method: 'POST', headers: { cookie: owner.cookie, origin: 'http://localhost' },
        body: extendRecordingForm(owner.csrfToken, recordingUploadId),
      }))
      assert.equal(sameTargetReplay.status, 303)
      assert.equal(sameTargetReplay.headers.get('location'), firstResponse.headers.get('location'))
      assert.equal(Number((await runtime.db.exec(sql`
        select count(*)::int count from handover_jobs where handover_id = ${firstHandoverId}
      `)).rows?.[0]?.count), 1)

      let otherTarget = await router.fetch(new Request('http://localhost' + routes.actions.extendHandover.href({ handoverId: secondHandoverId }), {
        method: 'POST', headers: { cookie: owner.cookie, origin: 'http://localhost' },
        body: extendRecordingForm(owner.csrfToken, recordingUploadId),
      }))
      assert.equal(otherTarget.status, 409)
      assert.equal(Number((await runtime.db.exec(sql`
        select count(*)::int count from handover_jobs where handover_id = ${secondHandoverId}
      `)).rows?.[0]?.count), 0)

      let unauthorized = await router.fetch(new Request('http://localhost' + routes.actions.extendHandover.href({ handoverId: firstHandoverId }), {
        method: 'POST', headers: { cookie: outsider.cookie, origin: 'http://localhost' },
        body: extendRecordingForm(outsider.csrfToken, recordingUploadId),
      }))
      assert.equal(unauthorized.status, 404)
      assert.equal(Number((await runtime.db.exec(sql`
        select count(*)::int count from handover_jobs where handover_id = ${firstHandoverId}
      `)).rows?.[0]?.count), 1)
      assert.equal(audio.stored.length, 1)
    } finally {
      await runtime.db.exec(sql`delete from handover_recording_uploads where user_id in (${ownerId}, ${outsiderId})`)
      await runtime.db.exec(sql`delete from handovers where id in (${firstHandoverId}, ${secondHandoverId})`)
      await runtime.db.exec(sql`delete from users where id in (${ownerId}, ${outsiderId})`)
      await runtime.close()
    }
  })

  it('keeps a deleted create result consumed instead of recreating it', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let userId = randomUUID()
    let recordingUploadId = randomUUID()
    let sessions = createMemorySessionStorage()
    let cookie = createCookie('recording-tombstone-session', { secrets: ['recording-tombstone-secret'], httpOnly: true, sameSite: 'Lax', path: '/' })
    let audio = recordingStorage()
    let router = createAppRouter({ data: runtime, sessionStorage: sessions, sessionCookie: cookie, audioStorage: audio.storage, publicOrigins: ['http://localhost'] })
    try {
      await runtime.db.exec(sql`insert into users(id, full_name, occupation, department) values(${userId}, 'Tombstone User', 'Nurse', 'Ward')`)
      let auth = await authenticatedBrowser({ router, sessions, cookie, userId })
      let first = await router.fetch(new Request('http://localhost' + routes.actions.createHandover.href(), {
        method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' },
        body: createRecordingForm(auth.csrfToken, recordingUploadId, 'Deleted durable create'),
      }))
      assert.equal(first.status, 303)
      let receipt = (await runtime.db.exec(sql`
        select handover_id from handover_recording_uploads
        where user_id = ${userId} and recording_upload_id = ${recordingUploadId}::uuid
      `)).rows?.[0]
      assert.ok(receipt)
      await runtime.db.exec(sql`delete from handovers where id = ${String(receipt.handover_id)}`)

      let replay = await router.fetch(new Request('http://localhost' + routes.actions.createHandover.href(), {
        method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' },
        body: createRecordingForm(auth.csrfToken, recordingUploadId, 'Deleted durable create'),
      }))
      assert.equal(replay.status, 410)
      assert.equal(Number((await runtime.db.exec(sql`
        select count(*)::int count from handover_recording_uploads
        where user_id = ${userId} and recording_upload_id = ${recordingUploadId}::uuid
      `)).rows?.[0]?.count), 1)
      assert.equal(Number((await runtime.db.exec(sql`
        select count(*)::int count from handovers where created_by_user_id = ${userId}
      `)).rows?.[0]?.count), 0)
      assert.equal(audio.stored.length, 1)
    } finally {
      await runtime.db.exec(sql`delete from handover_recording_uploads where user_id = ${userId}`)
      await runtime.db.exec(sql`delete from handovers where created_by_user_id = ${userId}`)
      await runtime.db.exec(sql`delete from users where id = ${userId}`)
      await runtime.close()
    }
  })
})
