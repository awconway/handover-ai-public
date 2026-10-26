import { randomUUID } from 'node:crypto'
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { sql, type Database, type SqlStatement } from 'remix/data-table'

import { createDataRuntime, deleteShift } from '../../app/data/index.ts'

class UnauthorizedDeletionDatabase {
  statements: SqlStatement[] = []

  async transaction<T>(callback: (db: Database) => Promise<T>): Promise<T> {
    return callback(this as unknown as Database)
  }

  async exec(statement: SqlStatement | string) {
    if (typeof statement !== 'string') this.statements.push(statement)
    return { rows: [] }
  }
}

type TestHandover = {
  id: string
  source_handover_id: string | null
  shift_id: string | null
  source_shift_id: string | null
  audio_blob_key: string | null
}

class ShiftDeletionDatabase {
  shiftDeleted = false
  statements: SqlStatement[] = []
  handovers: Map<string, TestHandover>
  audioRows: Array<{ handover_id: string; blob_key: string }>
  cleanupRows: Array<Record<string, unknown>> = []

  constructor(
    readonly shiftId: string,
    readonly ownerId: string,
    handovers: TestHandover[],
    audioRows: Array<{ handover_id: string; blob_key: string }>,
  ) {
    this.handovers = new Map(handovers.map((handover) => [handover.id, { ...handover }]))
    this.audioRows = audioRows.map((row) => ({ ...row }))
  }

  async transaction<T>(callback: (db: Database) => Promise<T>): Promise<T> {
    return callback(this as unknown as Database)
  }

  async exec(statement: SqlStatement | string) {
    if (typeof statement === 'string') return { rows: [] }
    this.statements.push(statement)
    let text = statement.text
    let values = statement.values
    if (/select \* from resource_cleanup_outbox/i.test(text)) {
      let row = this.cleanupRows.find((candidate) => (
        candidate.kind === values[0]
        && candidate.resource_id === values[1]
        && candidate.handover_id === values[2]
        && candidate.job_id === values[3]
        && candidate.revision === values[4]
      ))
      return { rows: row ? [row] : [] }
    }
    if (/pg_advisory_xact_lock/i.test(text)) return { rows: [{ pg_advisory_xact_lock: null }] }
    if (/select exists\(select 1 from handovers where audio_blob_key/i.test(text)) {
      let candidate = String(values[0])
      let referenced = [...this.handovers.values()].some((handover) => handover.audio_blob_key === candidate)
        || this.audioRows.some((row) => row.blob_key === candidate)
      return { rows: [{ referenced }] }
    }
    if (/insert into resource_cleanup_outbox/i.test(text)) {
      let now = new Date('2026-07-16T00:00:00.000Z')
      let row = {
        id: values[0], kind: values[1], resource_id: values[2], blob_key: values[3],
        handover_id: values[4], job_id: values[5], revision: values[6], status: 'queued', attempts: 0,
        next_retry_at: now, locked_by: null, locked_until: null, last_error: null, outcome: null,
        created_at: now, started_at: null, completed_at: null, updated_at: now,
      }
      this.cleanupRows.push(row)
      return { rows: [row] }
    }
    if (/select id from shifts[\s\S]*created_by_user_id/i.test(text)) {
      return { rows: !this.shiftDeleted && values[0] === this.shiftId && values[1] === this.ownerId ? [{ id: this.shiftId }] : [] }
    }
    if (/select id, coalesce\(source_handover_id, id\) as family_root_id/i.test(text)) {
      return { rows: [...this.handovers.values()]
        .filter((handover) => handover.shift_id === values[0] || handover.source_shift_id === values[1])
        .map((handover) => ({
          id: handover.id,
          family_root_id: handover.source_handover_id ?? handover.id,
        })) }
    }
    if (/select coalesce\(source_handover_id, id\) as family_root_id[\s\S]*where id/i.test(text)) {
      let handover = this.handovers.get(String(values[0]))
      return { rows: handover ? [{ family_root_id: handover.source_handover_id ?? handover.id }] : [] }
    }
    if (/select id, source_handover_id, coalesce\(source_handover_id, id\) as family_root_id/i.test(text)) {
      return { rows: [...this.handovers.values()]
        .filter((handover) => handover.shift_id === values[0] || handover.source_shift_id === values[1])
        .map((handover) => ({
          ...handover,
          family_root_id: handover.source_handover_id ?? handover.id,
        })) }
    }
    if (/select distinct blob_key from handover_audio[\s\S]*handover_id = any/i.test(text)) {
      let handoverIds = new Set(values[0] as string[])
      let keys = [...new Set(this.audioRows.filter((row) => handoverIds.has(row.handover_id)).map((row) => row.blob_key))]
      return { rows: keys.map((blob_key) => ({ blob_key })) }
    }
    if (/delete from handovers where id = any/i.test(text)) {
      let handoverIds = new Set(values[0] as string[])
      for (let id of handoverIds) this.handovers.delete(id)
      this.audioRows = this.audioRows.filter((row) => !handoverIds.has(row.handover_id))
      return { rows: [] }
    }
    if (/update handovers set[\s\S]*shift_id = case/i.test(text)) {
      let handoverIds = new Set(values[2] as string[])
      for (let id of handoverIds) {
        let handover = this.handovers.get(id)
        if (!handover) continue
        if (handover.shift_id === values[0]) handover.shift_id = null
        if (handover.source_shift_id === values[1]) handover.source_shift_id = null
      }
      return { rows: [] }
    }
    if (/delete from shifts[\s\S]*returning id/i.test(text)) {
      if (values[0] !== this.shiftId || values[1] !== this.ownerId || this.shiftDeleted) return { rows: [] }
      this.shiftDeleted = true
      return { rows: [{ id: this.shiftId }] }
    }
    if (/remaining_audio_references/i.test(text)) {
      let candidates = new Set(values[0] as string[])
      let keys = new Set<string>()
      for (let handover of this.handovers.values()) {
        if (handover.audio_blob_key && candidates.has(handover.audio_blob_key)) keys.add(handover.audio_blob_key)
      }
      for (let row of this.audioRows) if (candidates.has(row.blob_key)) keys.add(row.blob_key)
      return { rows: [...keys].map((blob_key) => ({ blob_key })) }
    }
    return { rows: [] }
  }
}

describe('shift deletion integrity', () => {
  it('performs no handover mutation when the actor does not own the shift', async () => {
    let db = new UnauthorizedDeletionDatabase()

    assert.equal(await deleteShift(db as unknown as Database, { id: 'shift-1', userId: 'assigned-user' }), null)
    assert.equal(db.statements.length, 1)
    assert.match(db.statements[0]!.text, /select id from shifts/i)
    assert.match(db.statements[0]!.text, /created_by_user_id/i)
    assert.doesNotMatch(db.statements[0]!.text, /update handovers|delete from handovers|delete from shifts/i)
  })

  it('deletes owned handovers, detaches copies and cross-shift records, and reports only orphaned audio', async () => {
    let db = new ShiftDeletionDatabase('shift-1', 'owner', [
      { id: 'owned', source_handover_id: null, shift_id: 'shift-1', source_shift_id: null, audio_blob_key: 'shared.webm' },
      { id: 'owned-source', source_handover_id: null, shift_id: null, source_shift_id: 'shift-1', audio_blob_key: 'orphan.webm' },
      { id: 'copy', source_handover_id: 'owned', shift_id: 'shift-1', source_shift_id: 'shift-1', audio_blob_key: 'shared.webm' },
      { id: 'cross-primary', source_handover_id: null, shift_id: 'shift-1', source_shift_id: 'shift-2', audio_blob_key: null },
      { id: 'cross-source', source_handover_id: null, shift_id: 'shift-2', source_shift_id: 'shift-1', audio_blob_key: null },
    ], [
      { handover_id: 'owned', blob_key: 'shared.webm' },
      { handover_id: 'copy', blob_key: 'shared.webm' },
      { handover_id: 'owned-source', blob_key: 'extension.webm' },
    ])

    let result = await deleteShift(db as unknown as Database, { id: 'shift-1', userId: 'owner' })

    let firstFamilyLock = db.statements.findIndex((statement) => /pg_advisory_xact_lock/i.test(statement.text))
    let shiftRowLock = db.statements.findIndex((statement) => (
      /select id from shifts[\s\S]*for update/i.test(statement.text)
    ))
    assert.ok(firstFamilyLock >= 0)
    assert.ok(shiftRowLock > firstFamilyLock)
    assert.deepEqual(result?.orphanedAudioKeys.sort(), ['extension.webm', 'orphan.webm'])
    assert.deepEqual(db.cleanupRows.map((row) => row.blob_key).sort(), ['extension.webm', 'orphan.webm'])
    assert.equal(db.shiftDeleted, true)
    assert.equal(db.handovers.has('owned'), false)
    assert.equal(db.handovers.has('owned-source'), false)
    assert.deepEqual(db.handovers.get('copy'), {
      id: 'copy', source_handover_id: 'owned', shift_id: null, source_shift_id: null, audio_blob_key: 'shared.webm',
    })
    assert.deepEqual(db.handovers.get('cross-primary'), {
      id: 'cross-primary', source_handover_id: null, shift_id: null, source_shift_id: 'shift-2', audio_blob_key: null,
    })
    assert.deepEqual(db.handovers.get('cross-source'), {
      id: 'cross-source', source_handover_id: null, shift_id: 'shift-2', source_shift_id: null, audio_blob_key: null,
    })
  })

  it('persists the shift deletion invariants against Postgres when configured', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let owner = randomUUID()
    let assigned = randomUUID()
    let targetShift = randomUUID()
    let otherShift = randomUUID()
    let ownedPrimary = randomUUID()
    let ownedSourceOnly = randomUUID()
    let recipientCopy = randomUUID()
    let crossPrimary = randomUUID()
    let crossSource = randomUUID()
    let sharedAudioKey = `${randomUUID()}-shared.webm`
    let orphanAudioKey = `${randomUUID()}-orphan.webm`
    let orphanExtensionKey = `${randomUUID()}-extension.webm`
    let preservedExceptionId = randomUUID()
    let removedExceptionId = randomUUID()

    try {
      for (let userId of [owner, assigned]) {
        await runtime.db.exec(sql`
          insert into users(id, full_name, occupation, department)
          values(${userId}, ${userId}, 'Nurse', 'Ward')
        `)
      }
      await runtime.db.exec(sql`
        insert into shifts(id, created_by_user_id, title, department, assigned_user_ids)
        values
          (${targetShift}, ${owner}, 'Target shift', 'Ward', ${JSON.stringify([assigned])}::jsonb),
          (${otherShift}, ${owner}, 'Other shift', 'Ward', '[]'::jsonb)
      `)
      await runtime.db.exec(sql`
        insert into handovers(
          id, created_by_user_id, source_handover_id, shift_id, source_shift_id,
          title, source_department, context_type, consent_mode, priority_preference,
          processing_status, audio_blob_key
        ) values
          (${ownedPrimary}, ${owner}, null, ${targetShift}, null,
            'Owned primary', 'Ward', 'shift-handover', 'verbal', 'balanced', 'completed', ${sharedAudioKey}),
          (${ownedSourceOnly}, ${owner}, null, null, ${targetShift},
            'Owned source', 'Ward', 'shift-handover', 'verbal', 'balanced', 'completed', ${orphanAudioKey}),
          (${recipientCopy}, ${assigned}, ${ownedPrimary}, ${targetShift}, ${targetShift},
            'Recipient copy', 'Ward', 'shift-handover', 'verbal', 'balanced', 'completed', ${sharedAudioKey}),
          (${crossPrimary}, ${owner}, null, ${targetShift}, ${otherShift},
            'Cross-shift primary', 'Ward', 'shift-handover', 'verbal', 'balanced', 'completed', null),
          (${crossSource}, ${owner}, null, ${otherShift}, ${targetShift},
            'Cross-shift source', 'Ward', 'shift-handover', 'verbal', 'balanced', 'completed', null)
      `)
      await runtime.db.exec(sql`
        insert into handover_audio(
          id, handover_id, revision, purpose, blob_key, content_type, original_filename, size_bytes
        ) values
          (${randomUUID()}, ${ownedPrimary}, 1, 'initial', ${sharedAudioKey}, 'audio/webm', 'shared.webm', 100),
          (${randomUUID()}, ${recipientCopy}, 1, 'initial', ${sharedAudioKey}, 'audio/webm', 'shared.webm', 100),
          (${randomUUID()}, ${ownedSourceOnly}, 1, 'extension', ${orphanExtensionKey}, 'audio/webm', 'extension.webm', 100)
      `)
      await runtime.db.exec(sql`
        insert into local_privacy_exceptions(
          id,handover_family_id,normalized_text,canonical_label,
          source_handover_id,source_original_text,created_by_user_id
        ) values
          (${preservedExceptionId},${ownedPrimary},'Bill','PERSON',${ownedPrimary},'Bill',${owner}),
          (${removedExceptionId},${ownedSourceOnly},'Julie','PERSON',${ownedSourceOnly},'Julie',${owner})
      `)

      let rejected = await deleteShift(runtime.db, { id: targetShift, userId: assigned })
      assert.equal(rejected, null)
      let beforeOwnerDelete = (await runtime.db.exec(sql`
        select shift_id, source_shift_id from handovers where id = ${ownedPrimary}
      `)).rows?.[0]
      assert.deepEqual(beforeOwnerDelete, { shift_id: targetShift, source_shift_id: null })

      let deleted = await deleteShift(runtime.db, { id: targetShift, userId: owner })
      assert.ok(deleted)
      assert.deepEqual(deleted.orphanedAudioKeys.sort(), [orphanAudioKey, orphanExtensionKey].sort())
      let cleanupRows = (await runtime.db.exec(sql`
        select blob_key, status from resource_cleanup_outbox
        where job_id = ${`explicit-audio-deletion:shift:${targetShift}`}
        order by blob_key
      `)).rows ?? []
      assert.deepEqual(cleanupRows, [orphanAudioKey, orphanExtensionKey].sort().map((blob_key) => ({ blob_key, status: 'queued' })))
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int count from shifts where id = ${targetShift}
      `)).rows?.[0]?.count, 0)
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int count from handovers where id = any(${[ownedPrimary, ownedSourceOnly]}::text[])
      `)).rows?.[0]?.count, 0)

      let preserved = (await runtime.db.exec(sql`
        select id, shift_id, source_shift_id from handovers
        where id = any(${[recipientCopy, crossPrimary, crossSource]}::text[])
        order by id
      `)).rows ?? []
      let byId = new Map(preserved.map((row) => [String(row.id), row]))
      assert.deepEqual(byId.get(recipientCopy), { id: recipientCopy, shift_id: null, source_shift_id: null })
      assert.deepEqual(byId.get(crossPrimary), { id: crossPrimary, shift_id: null, source_shift_id: otherShift })
      assert.deepEqual(byId.get(crossSource), { id: crossSource, shift_id: otherShift, source_shift_id: null })
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int count from handover_audio where handover_id = ${recipientCopy} and blob_key = ${sharedAudioKey}
      `)).rows?.[0]?.count, 1)
      assert.deepEqual((await runtime.db.exec(sql`
        select id from local_privacy_exceptions
        where id in (${preservedExceptionId},${removedExceptionId})
        order by id
      `)).rows, [{ id: preservedExceptionId }])
    } finally {
      await runtime.db.exec(sql`
        delete from resource_cleanup_outbox
        where job_id = ${`explicit-audio-deletion:shift:${targetShift}`}
      `)
      await runtime.db.exec(sql`
        delete from handovers
        where id = any(${[ownedPrimary, ownedSourceOnly, recipientCopy, crossPrimary, crossSource]}::text[])
      `)
      await runtime.db.exec(sql`
        delete from local_privacy_exceptions
        where id in (${preservedExceptionId},${removedExceptionId})
      `)
      await runtime.db.exec(sql`delete from shifts where id = any(${[targetShift, otherShift]}::text[])`)
      await runtime.db.exec(sql`delete from users where id = any(${[owner, assigned]}::text[])`)
      await runtime.close()
    }
  })
})
