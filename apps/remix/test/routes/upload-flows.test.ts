import { randomUUID } from 'node:crypto'
import * as assert from 'remix/assert'
import { createCookie } from 'remix/cookie'
import { createSession } from 'remix/session'
import { createMemorySessionStorage } from 'remix/session-storage/memory'
import { describe, it } from 'remix/test'

import type { UploadInput, UploadStorage } from '../../app/data/index.ts'
import { createAppRouter } from '../../app/router.ts'
import { routes } from '../../app/routes.ts'

function harness(options: {
  failAudioMetadata?: boolean
  failSheetCleanup?: boolean
  shiftOwnerId?: string
} = {}) {
  let user = { id: 'user-1', full_name: 'Avery Clinician', occupation: 'Nurse', department: 'General Medicine', created_at: new Date(), updated_at: new Date(), last_active_at: new Date() }
  let shift = { id: 'shift-1', created_by_user_id: options.shiftOwnerId ?? user.id, title: 'Evening cover', department: user.department, assigned_user_ids: [user.id], notes: '', patient_order: [], status: 'active', created_at: new Date(), updated_at: new Date() }
  let shiftDeleted = false
  let handovers = new Map<string, Record<string, any>>()
  let sheetPatients = new Map<string, Record<string, any>>()
  let jobs: Record<string, any>[] = []
  let audioRows: Record<string, any>[] = []
  let recordingUploads = new Map<string, Record<string, any>>()
  let cleanupRows = new Map<string, Record<string, any>>()

  let db: any = {
    async find(table: any, id: string) {
      if ('full_name' in table) return id === user.id ? user : null
      if ('consent_mode' in table) return handovers.get(id) ?? null
      return null
    },
    async findOne(table: any, options: any) {
      if ('recording_upload_id' in table && 'request_fingerprint' in table) {
        return recordingUploads.get(`${options.where.user_id}:${options.where.recording_upload_id}`) ?? null
      }
      if ('patient_key' in table && 'source_file_key' in table) return sheetPatients.get(`${options.where.shift_id}:${options.where.patient_key}`) ?? null
      return null
    },
    async findMany(table: any, options?: any) {
      if ('patient_key' in table && 'source_file_key' in table) return [...sheetPatients.values()].filter((row) => !options?.where?.shift_id || row.shift_id === options.where.shift_id)
      if ('full_name' in table) return [user]
      return []
    },
    async create(table: any, value: Record<string, any>) {
      let row = { ...value }
      if ('consent_mode' in table) handovers.set(row.id, row)
      if ('recording_upload_id' in table && 'request_fingerprint' in table) {
        recordingUploads.set(`${row.user_id}:${row.recording_upload_id}`, row)
      }
      if ('blob_key' in table && 'purpose' in table) {
        if (options.failAudioMetadata) throw new Error('injected audio metadata failure')
        audioRows.push(row)
      }
      if ('patient_order' in table) return { ...row, id: 'shift-1', created_at: new Date(), updated_at: new Date() }
      return row
    },
    async update(table: any, id: string, value: Record<string, any>) {
      if ('consent_mode' in table) {
        let row = { ...handovers.get(id), ...value }
        handovers.set(id, row)
        return row
      }
      return value
    },
    async transaction(callback: (tx: any) => unknown) {
      let handoverSnapshot = new Map(handovers)
      let jobsSnapshot = jobs.map((row) => ({ ...row }))
      let audioSnapshot = audioRows.map((row) => ({ ...row }))
      let recordingSnapshot = new Map(recordingUploads)
      let cleanupSnapshot = new Map([...cleanupRows].map(([key, row]) => [key, { ...row }]))
      try {
        return await callback(db)
      } catch (error) {
        handovers.clear(); for (let [key, row] of handoverSnapshot) handovers.set(key, row)
        jobs.splice(0, jobs.length, ...jobsSnapshot)
        audioRows.splice(0, audioRows.length, ...audioSnapshot)
        recordingUploads.clear(); for (let [key, row] of recordingSnapshot) recordingUploads.set(key, row)
        cleanupRows.clear(); for (let [key, row] of cleanupSnapshot) cleanupRows.set(key, row)
        throw error
      }
    },
    async exec(statement: any) {
      let text = typeof statement === 'string' ? statement : statement.text
      let values = typeof statement === 'string' ? [] : statement.values
      if (/pg_advisory_xact_lock/i.test(text)) return { rows: [{ pg_advisory_xact_lock: null }] }
      if (/select coalesce\(source_handover_id, id\) as family_root_id[\s\S]*from handovers where id/i.test(text)) {
        let row = handovers.get(String(values[0]))
        return { rows: row ? [{ family_root_id: row.source_handover_id ?? row.id }] : [] }
      }
      if (/select id, coalesce\(source_handover_id, id\) as family_root_id[\s\S]*where shift_id/i.test(text)) {
        return { rows: [...handovers.values()]
          .filter((row) => row.shift_id === values[0] || row.source_shift_id === values[1])
          .map((row) => ({ id: row.id, family_root_id: row.source_handover_id ?? row.id })) }
      }
      if (/select id, privacy_mode_floor, coalesce\(source_handover_id, id\) as family_root_id[\s\S]*from handovers where id[\s\S]*for update/i.test(text)) {
        let row = handovers.get(String(values[0]))
        return {
          rows: row ? [{
            id: row.id,
            privacy_mode_floor: row.privacy_mode_floor ?? 'cloud',
            family_root_id: row.source_handover_id ?? row.id,
          }] : [],
        }
      }
      if (/select \* from resource_cleanup_outbox/i.test(text)) {
        let cleanupId = values.find((value: unknown) => typeof value === 'string' && cleanupRows.has(value)) as string | undefined
        if (cleanupId) return { rows: [cleanupRows.get(cleanupId)] }
        let blobKey = values.find((value: unknown) => typeof value === 'string' && [...cleanupRows.values()].some((row) => row.blob_key === value))
        let row = [...cleanupRows.values()].find((candidate) => candidate.blob_key === blobKey)
        return { rows: row ? [row] : [] }
      }
      if (/insert into resource_cleanup_outbox/i.test(text)) {
        let now = new Date()
        let row = {
          id: values[0], kind: values[1], resource_id: values[2], blob_key: values[3],
          handover_id: values[4], job_id: values[5], revision: 1, status: 'queued', attempts: 0,
          next_retry_at: new Date(now.getTime() + Number(values[6] ?? 60_000)), locked_by: null,
          locked_until: null, last_error: null, outcome: null, created_at: now, started_at: null,
          completed_at: null, updated_at: now,
        }
        cleanupRows.set(String(row.id), row)
        return { rows: [row] }
      }
      if (/select id(?:, status)? from resource_cleanup_outbox/i.test(text)) {
        let blobKey = values.find((value: unknown) => typeof value === 'string' && [...cleanupRows.values()].some((row) => row.blob_key === value))
        let excludedId = values.find((value: unknown) => typeof value === 'string' && cleanupRows.has(value))
        let row = [...cleanupRows.values()].find((candidate) => candidate.blob_key === blobKey && candidate.id !== excludedId)
        return { rows: row ? [{ id: row.id, status: row.status }] : [] }
      }
      if (/delete from resource_cleanup_outbox where id/i.test(text)) {
        let id = String(values[0])
        let found = cleanupRows.delete(id)
        return { rows: found ? [{ id }] : [] }
      }
      if (/select h\.\*/i.test(text)) return { rows: [handovers.get(String(values[0]))].filter(Boolean) }
      if (/select id, privacy_mode_floor from handovers where id/i.test(text)) {
        let row = handovers.get(String(values[0]))
        return { rows: row ? [{ id: row.id, privacy_mode_floor: row.privacy_mode_floor ?? 'cloud' }] : [] }
      }
      if (/select id from handovers where id/i.test(text)) {
        let row = handovers.get(String(values[0]))
        let expectedVersion = values.find((value: unknown) => typeof value === 'number')
        return { rows: row && (expectedVersion == null || row.version === expectedVersion) ? [{ id: row.id }] : [] }
      }
      if (/update handovers set privacy_mode_floor = 'local-first'/i.test(text)) {
        let row = handovers.get(String(values[0]))
        if (row) row.privacy_mode_floor = 'local-first'
        return { rows: [] }
      }
      if (/select \* from shifts where id/i.test(text)) return { rows: !shiftDeleted && values[0] === shift.id ? [shift] : [] }
      if (/select \* from shift_sheet_patients[\s\S]*where shift_id[\s\S]*order by patient_key[\s\S]*for update/i.test(text)) {
        return { rows: [...sheetPatients.values()].filter((row) => row.shift_id === values[0]) }
      }
      if (/select \* from shift_sheet_patients[\s\S]*shift_id[\s\S]*patient_key[\s\S]*for update/i.test(text)) {
        let row = sheetPatients.get(`${values[0]}:${values[1]}`)
        return { rows: row ? [row] : [] }
      }
      if (/select id from shifts[\s\S]*created_by_user_id/i.test(text)) {
        return { rows: !shiftDeleted && values[0] === shift.id && values[1] === shift.created_by_user_id ? [{ id: shift.id }] : [] }
      }
      if (/select id, source_handover_id,[\s\S]*shift_id, source_shift_id, audio_blob_key[\s\S]*from handovers/i.test(text)) {
        return { rows: [...handovers.values()]
          .filter((row) => row.shift_id === values[0] || row.source_shift_id === values[1])
          .map((row) => ({ ...row, family_root_id: row.source_handover_id ?? row.id })) }
      }
      if (/select distinct blob_key from handover_audio[\s\S]*handover_id = any/i.test(text)) {
        let ids = new Set(values[0] as string[])
        let keys = [...new Set(audioRows.filter((row) => ids.has(row.handover_id)).map((row) => row.blob_key))]
        return { rows: keys.map((blob_key) => ({ blob_key })) }
      }
      if (/delete from handovers where id = any/i.test(text)) {
        let ids = new Set(values[0] as string[])
        for (let id of ids) handovers.delete(id)
        audioRows = audioRows.filter((row) => !ids.has(row.handover_id))
        return { rows: [] }
      }
      if (/update handovers set[\s\S]*shift_id = case/i.test(text)) {
        let ids = new Set(values[2] as string[])
        for (let id of ids) {
          let row = handovers.get(id)
          if (!row) continue
          if (row.shift_id === values[0]) row.shift_id = null
          if (row.source_shift_id === values[1]) row.source_shift_id = null
        }
        return { rows: [] }
      }
      if (/select exists\(select 1 from handovers where audio_blob_key/i.test(text)) {
        let candidate = String(values[0])
        let referenced = [...handovers.values()].some((row) => row.audio_blob_key === candidate)
          || audioRows.some((row) => row.blob_key === candidate)
        return { rows: [{ referenced }] }
      }
      if (/remaining_audio_references/i.test(text)) {
        let candidates = new Set(values[0] as string[])
        let keys = new Set<string>()
        for (let row of handovers.values()) if (candidates.has(row.audio_blob_key)) keys.add(row.audio_blob_key)
        for (let row of audioRows) if (candidates.has(row.blob_key)) keys.add(row.blob_key)
        return { rows: [...keys].map((blob_key) => ({ blob_key })) }
      }
      if (/select distinct source_file_key from shift_sheet_patients[\s\S]*where shift_id/i.test(text)) {
        let keys = [...new Set([...sheetPatients.values()].filter((row) => row.shift_id === values[0] && row.source_file_key).map((row) => row.source_file_key))]
        return { rows: keys.map((source_file_key) => ({ source_file_key })) }
      }
      if (/select distinct source_file_key from shift_sheet_patients[\s\S]*source_file_key = any/i.test(text)) {
        let candidates = new Set(values[0] as string[])
        let keys = [...new Set([...sheetPatients.values()].filter((row) => candidates.has(row.source_file_key)).map((row) => row.source_file_key))]
        return { rows: keys.map((source_file_key) => ({ source_file_key })) }
      }
      if (/insert into handover_jobs/i.test(text)) {
        let now = new Date()
        let row = {
          id: values[0], handover_id: values[1], revision: values[2], kind: values[3], status: 'queued', attempts: 0,
          locked_by: null, locked_until: null, payload: JSON.parse(String(values[4])), created_at: now, started_at: null,
          completed_at: null, failed_at: null, updated_at: now, error_message: null,
        }
        jobs.push(row)
        return { rows: [row] }
      }
      if (/insert into shift_sheet_patients/i.test(text)) {
        let row = {
          id: values[0], shift_id: values[1], patient_key: values[2], display_name: values[3], location: values[4],
          fields: JSON.parse(String(values[5])), raw_text: values[6], source_file_name: values[7], source_file_key: values[8],
          source_file_content_type: values[9], source_file_size_bytes: values[10], extraction_method: values[11], row_index: values[12],
          imported_by_user_id: values[13], imported_at: new Date(), updated_at: new Date(),
        }
        sheetPatients.set(`${row.shift_id}:${row.patient_key}`, row)
        return { rows: [row] }
      }
      if (/delete from shift_sheet_patients where shift_id/i.test(text)) {
        let keep = new Set(values[1] as string[])
        for (let [key, row] of sheetPatients) if (row.shift_id === values[0] && !keep.has(row.patient_key)) sheetPatients.delete(key)
        return { rows: [] }
      }
      if (/update shifts set patient_order/i.test(text)) { shift.patient_order = JSON.parse(String(values[0])); return { rows: [shift] } }
      if (/update shift_sheet_patients set fields/i.test(text)) {
        let row = [...sheetPatients.values()].find((candidate) => candidate.id === values[3])!
        Object.assign(row, { fields: JSON.parse(String(values[0])), display_name: values[1], location: values[2], updated_at: new Date() })
        return { rows: [row] }
      }
      if (/delete from shifts[\s\S]*where id/i.test(text)) {
        if (values[0] !== shift.id || values[1] !== shift.created_by_user_id || shiftDeleted) return { rows: [] }
        shiftDeleted = true
        for (let [key, row] of sheetPatients) if (row.shift_id === shift.id) sheetPatients.delete(key)
        return { rows: [{ id: shift.id }] }
      }
      return { rows: [] }
    },
  }

  function memoryUploads(prefix: string, options: { failDelete?: boolean } = {}) {
    let stored: Array<{ key: string; input: UploadInput }> = []
    let deleted: string[] = []
    let storage: UploadStorage = {
      async put(input) { let key = `${prefix}-${stored.length + 1}.bin`; stored.push({ key, input }); return { key, sizeBytes: input.bytes.length, contentType: input.contentType, originalFilename: input.filename } },
      async putFileAtKey(key, file) {
        let input = { bytes: Buffer.from(await file.arrayBuffer()), contentType: file.type, filename: file.name }
        if (!stored.some((item) => item.key === key)) stored.push({ key, input })
        return { key, sizeBytes: file.size, contentType: file.type, originalFilename: file.name }
      },
      async getStream() { throw new Error('not needed') },
      async delete(key) {
        deleted.push(key)
        if (options.failDelete) throw new Error('injected upload cleanup failure')
        return true
      },
      async healthCheck() {},
    }
    return { storage, stored, deleted }
  }

  let sessions = createMemorySessionStorage()
  let cookie = createCookie('upload-test-session', { secrets: ['upload-test-secret'], httpOnly: true, sameSite: 'Lax', path: '/' })
  let audio = memoryUploads('audio')
  let sheets = memoryUploads('sheet', { failDelete: options.failSheetCleanup })
  let runtime = { db, pool: {}, async ready() {}, async close() {} }
  let router = createAppRouter({ data: runtime as never, sessionStorage: sessions, sessionCookie: cookie, audioStorage: audio.storage, sheetStorage: sheets.storage, publicOrigins: ['http://localhost'] })
  function addSheetPatient(shiftId: string, patientKey: string, sourceFileKey: string) {
    sheetPatients.set(`${shiftId}:${patientKey}`, {
      id: `${shiftId}-${patientKey}`, shift_id: shiftId, patient_key: patientKey, display_name: patientKey,
      location: 'Ward', fields: [], raw_text: '', source_file_name: 'old.csv', source_file_key: sourceFileKey,
      source_file_content_type: 'text/csv', source_file_size_bytes: 10, extraction_method: 'text', row_index: 0,
      imported_by_user_id: user.id, imported_at: new Date(), updated_at: new Date(),
    })
  }
  return { router, sessions, cookie, shift, handovers, sheetPatients, jobs, recordingUploads, cleanupRows, get audioRows() { return audioRows }, audio, sheets, addSheetPatient }
}

async function browser(h: ReturnType<typeof harness>) {
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

function handoverForm(token: string) {
  let body = new FormData()
  body.set('_csrf', token); body.set('title', 'Ward transfer'); body.set('contextType', 'shift-handover')
  body.set('direction', 'incoming'); body.set('sourceDepartment', 'Emergency'); body.set('consentMode', 'agreed')
  return body
}

describe('native upload and handover-sheet routes', () => {
  it('queues a manual transcript without creating an audio object', async () => {
    let h = harness(), auth = await browser(h), body = handoverForm(auth.token)
    body.set('manualTranscript', 'Patient is stable and awaiting review.')
    let response = await h.router.fetch(new Request('http://localhost' + routes.actions.createHandover.href(), { method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body }))
    assert.equal(response.status, 303)
    assert.equal(h.handovers.size, 1)
    assert.equal([...h.handovers.values()][0]!.transcript, 'Patient is stable and awaiting review.')
    assert.equal(h.audio.stored.length, 0)
    assert.equal(h.jobs.length, 1)
  })

  it('persists a handover with no shift binding when the individual composer submits an empty shift id', async () => {
    let h = harness(), auth = await browser(h), body = handoverForm(auth.token)
    body.set('shiftId', '')
    body.set('manualTranscript', 'An individual transfer handover awaiting review.')

    let response = await h.router.fetch(new Request('http://localhost' + routes.actions.createHandover.href(), {
      method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body,
    }))

    assert.equal(response.status, 303)
    assert.equal([...h.handovers.values()][0]!.shift_id, null)
    assert.match(response.headers.get('location') ?? '', /^\/handover\//)
  })

  it('persists intra-shift direction without coercing it to incoming', async () => {
    let h = harness(), auth = await browser(h), body = handoverForm(auth.token)
    body.set('direction', 'intra-shift')
    body.set('manualTranscript', 'Patient status changed during the current shift.')
    let response = await h.router.fetch(new Request('http://localhost' + routes.actions.createHandover.href(), { method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body }))
    assert.equal(response.status, 303)
    assert.equal([...h.handovers.values()][0]!.direction, 'intra-shift')
  })

  it('stores the clinical route in delivery order for a receiving shift handover', async () => {
    let h = harness(), auth = await browser(h), body = handoverForm(auth.token)
    body.set('sourceDepartment', 'General Medicine')
    body.set('destinationDepartment', 'Emergency')
    body.set('manualTranscript', 'Receiving the patient from Emergency.')
    let response = await h.router.fetch(new Request('http://localhost' + routes.actions.createHandover.href(), { method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body }))
    assert.equal(response.status, 303)
    let handover = [...h.handovers.values()][0]!
    assert.equal(handover.source_department, 'Emergency')
    assert.equal(handover.destination_department, 'General Medicine')
  })

  it('rejects an inaccessible source shift before creating a cross-shift handover', async () => {
    let h = harness(), auth = await browser(h), body = handoverForm(auth.token)
    body.set('sourceShiftId', 'inaccessible-shift')
    body.set('manualTranscript', 'Patient is arriving from another shift.')

    let response = await h.router.fetch(new Request('http://localhost' + routes.actions.createHandover.href(), {
      method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body,
    }))

    assert.equal(response.status, 404)
    assert.equal(h.handovers.size, 0)
    assert.equal(h.jobs.length, 0)
  })

  it('validates, stores, records, and queues an audio handover', async () => {
    let h = harness(), auth = await browser(h), body = handoverForm(auth.token)
    body.set('recordingUploadId', randomUUID())
    body.set('audio', new File([Buffer.from('RIFF-test-audio')], 'handover.wav', { type: 'audio/wav' }))
    let response = await h.router.fetch(new Request('http://localhost' + routes.actions.createHandover.href(), { method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body }))
    assert.equal(response.status, 303)
    assert.equal(h.audio.stored.length, 1)
    assert.equal(h.audioRows.length, 1)
    assert.equal([...h.handovers.values()][0]!.audio_blob_key, h.audio.stored[0]!.key)
    assert.equal(h.jobs.length, 1)
  })

  it('rejects an invalid recording upload identifier before storing audio', async () => {
    let h = harness(), auth = await browser(h), body = handoverForm(auth.token)
    body.set('recordingUploadId', 'not-a-uuid')
    body.set('audio', new File([Buffer.from('RIFF-test-audio')], 'handover.wav', { type: 'audio/wav' }))
    let response = await h.router.fetch(new Request('http://localhost' + routes.actions.createHandover.href(), {
      method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body,
    }))
    assert.equal(response.status, 400)
    assert.equal(h.audio.stored.length, 0)
    assert.equal(h.handovers.size, 0)
    assert.equal(h.jobs.length, 0)
  })

  it('rejects a manual transcript and audio recording submitted together', async () => {
    let h = harness(), auth = await browser(h), body = handoverForm(auth.token)
    body.set('recordingUploadId', randomUUID())
    body.set('manualTranscript', 'Use this text instead of the uploaded recording.')
    body.set('audio', new File([Buffer.from('RIFF-unused-audio')], 'handover.wav', { type: 'audio/wav' }))
    let response = await h.router.fetch(new Request('http://localhost' + routes.actions.createHandover.href(), {
      method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body,
    }))
    assert.equal(response.status, 400)
    assert.equal(h.handovers.size, 0)
    assert.equal(h.audio.stored.length, 0)
    assert.equal(h.audioRows.length, 0)
    assert.equal(h.jobs.length, 0)
  })

  it('keeps durable cleanup intent when the database transaction fails', async () => {
    let h = harness({ failAudioMetadata: true }), auth = await browser(h), body = handoverForm(auth.token)
    body.set('recordingUploadId', randomUUID())
    body.set('audio', new File([Buffer.from('RIFF-test-audio')], 'handover.wav', { type: 'audio/wav' }))
    let response = await h.router.fetch(new Request('http://localhost' + routes.actions.createHandover.href(), { method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body }))
    assert.equal(response.status, 500)
    assert.equal(h.audio.stored.length, 1)
    assert.deepEqual(h.audio.deleted, [])
    assert.equal(h.cleanupRows.size, 1)
    assert.equal([...h.cleanupRows.values()][0]!.blob_key, h.audio.stored[0]!.key)
    assert.equal(h.audioRows.length, 0)
  })

  it('imports a CSV sheet and persists a human field review', async () => {
    let h = harness(), auth = await browser(h)
    let upload = new FormData()
    upload.set('_csrf', auth.token)
    upload.set('sheet', new File(['Name,Bed,Diagnosis\nAlex,Ward 3,Pneumonia\n'], 'shift.csv', { type: 'text/csv' }))
    let imported = await h.router.fetch(new Request('http://localhost' + routes.actions.importHandoverSheet.href({ shiftId: h.shift.id }), { method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body: upload }))
    assert.equal(imported.status, 303)
    assert.deepEqual(h.shift.patient_order, ['alex-ward-3'])
    assert.equal(h.sheets.stored.length, 0)
    let importedPatient = h.sheetPatients.get(`${h.shift.id}:alex-ward-3`)!
    assert.equal(importedPatient.source_file_key, null)
    assert.equal(importedPatient.source_file_size_bytes, 41)

    let review = new FormData()
    review.set('_csrf', auth.token); review.set('value', 'Confirmed pneumonia'); review.set('fieldKey', 'diagnosis')
    let reviewed = await h.router.fetch(new Request('http://localhost' + routes.actions.reviewPatientField.href({ shiftId: h.shift.id, patientKey: 'alex-ward-3', fieldKey: 'diagnosis' }), { method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body: review }))
    assert.equal(reviewed.status, 303)
    let diagnosis = h.sheetPatients.get(`${h.shift.id}:alex-ward-3`)!.fields.find((field: any) => field.columnKey === 'diagnosis')
    assert.equal(diagnosis.finalAcceptedValue, 'Confirmed pneumonia')
    assert.equal(diagnosis.reviewStatus, 'human_verified')
    assert.equal(diagnosis.reviewDecision, 'edited')
  })

  it('handles accept and reject as distinct patient-field review decisions', async () => {
    let h = harness(), auth = await browser(h)
    let upload = new FormData()
    upload.set('_csrf', auth.token)
    upload.set('sheet', new File(['Name,Bed,Diagnosis\nAlex,Ward 3,Pneumonia\n'], 'shift.csv', { type: 'text/csv' }))
    let imported = await h.router.fetch(new Request('http://localhost' + routes.actions.importHandoverSheet.href({ shiftId: h.shift.id }), {
      method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body: upload,
    }))
    assert.equal(imported.status, 303)

    let href = routes.actions.reviewPatientField.href({ shiftId: h.shift.id, patientKey: 'alex-ward-3', fieldKey: 'diagnosis' })
    let accept = new FormData()
    accept.set('_csrf', auth.token)
    accept.set('fieldKey', 'diagnosis')
    accept.set('value', 'Client-side value must not replace an accepted extraction')
    accept.set('decision', 'accepted')
    let accepted = await h.router.fetch(new Request('http://localhost' + href, {
      method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body: accept,
    }))
    assert.equal(accepted.status, 303)
    let diagnosis = h.sheetPatients.get(`${h.shift.id}:alex-ward-3`)!.fields.find((field: any) => field.columnKey === 'diagnosis')
    assert.equal(diagnosis.finalAcceptedValue, 'Pneumonia')
    assert.equal(diagnosis.reviewDecision, 'accepted')

    let reject = new FormData()
    reject.set('_csrf', auth.token)
    reject.set('fieldKey', 'diagnosis')
    reject.set('value', 'Pneumonia')
    reject.set('decision', 'rejected')
    let rejected = await h.router.fetch(new Request('http://localhost' + href, {
      method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body: reject,
    }))
    assert.equal(rejected.status, 303)
    diagnosis = h.sheetPatients.get(`${h.shift.id}:alex-ward-3`)!.fields.find((field: any) => field.columnKey === 'diagnosis')
    assert.equal(diagnosis.finalAcceptedValue, '')
    assert.equal(diagnosis.reviewDecision, 'rejected')
    assert.equal(diagnosis.reviewEvents.length, 2)
  })

  it('removes only unreferenced source objects when replacing a shift sheet', async () => {
    let h = harness(), auth = await browser(h)
    h.addSheetPatient(h.shift.id, 'exclusive-patient', 'sheet-exclusive.csv')
    h.addSheetPatient(h.shift.id, 'shared-patient', 'sheet-shared.csv')
    h.addSheetPatient('shift-2', 'shared-patient', 'sheet-shared.csv')
    let upload = new FormData()
    upload.set('_csrf', auth.token)
    upload.set('sheet', new File(['Name,Bed\nReplacement,Ward 9\n'], 'replacement.csv', { type: 'text/csv' }))
    let response = await h.router.fetch(new Request('http://localhost' + routes.actions.importHandoverSheet.href({ shiftId: h.shift.id }), {
      method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body: upload,
    }))
    assert.equal(response.status, 303)
    assert.deepEqual(h.sheets.deleted, ['sheet-exclusive.csv'])
    assert.ok([...h.sheetPatients.values()].some((row) => row.shift_id === 'shift-2' && row.source_file_key === 'sheet-shared.csv'))
  })

  it('keeps the extracted import durable when legacy source cleanup fails', async () => {
    let h = harness({ failSheetCleanup: true }), auth = await browser(h)
    h.addSheetPatient(h.shift.id, 'legacy-patient', 'sheet-legacy.csv')
    let upload = new FormData()
    upload.set('_csrf', auth.token)
    upload.set('sheet', new File(['Name,Bed\nReplacement,Ward 9\n'], 'replacement.csv', { type: 'text/csv' }))

    let response = await h.router.fetch(new Request(
      'http://localhost' + routes.actions.importHandoverSheet.href({ shiftId: h.shift.id }),
      { method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body: upload },
    ))

    assert.equal(response.status, 303)
    assert.deepEqual(h.sheets.deleted, ['sheet-legacy.csv'])
    assert.equal(h.sheets.stored.length, 0)
    let replacement = h.sheetPatients.get(`${h.shift.id}:replacement-ward-9`)
    assert.ok(replacement)
    assert.equal(replacement.source_file_key, null)
    assert.ok(
      [...h.sheetPatients.values()]
        .filter((row) => row.shift_id === h.shift.id)
        .every((row) => row.source_file_key == null),
    )
    assert.deepEqual(h.shift.patient_order, ['replacement-ward-9'])
  })

  it('removes only unreferenced source objects when deleting a shift', async () => {
    let h = harness(), auth = await browser(h)
    h.addSheetPatient(h.shift.id, 'exclusive-patient', 'sheet-exclusive.csv')
    h.addSheetPatient(h.shift.id, 'shared-patient', 'sheet-shared.csv')
    h.addSheetPatient('shift-2', 'shared-patient', 'sheet-shared.csv')
    h.handovers.set('attached-handover', {
      id: 'attached-handover', source_handover_id: null, shift_id: h.shift.id, source_shift_id: null,
      audio_blob_key: 'audio-initial.webm',
    })
    h.audioRows.push({ handover_id: 'attached-handover', blob_key: 'audio-extension.webm' })
    let body = new FormData()
    body.set('_csrf', auth.token)
    let response = await h.router.fetch(new Request('http://localhost' + routes.actions.deleteShift.href({ shiftId: h.shift.id }), {
      method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body,
    }))
    assert.equal(response.status, 303)
    assert.deepEqual(h.sheets.deleted, ['sheet-exclusive.csv'])
    assert.equal(h.handovers.has('attached-handover'), false)
    assert.deepEqual(h.audio.deleted, [])
    assert.deepEqual(
      [...h.cleanupRows.values()].map((row) => row.blob_key).sort(),
      ['audio-extension.webm', 'audio-initial.webm'],
    )
    assert.ok([...h.sheetPatients.values()].some((row) => row.shift_id === 'shift-2' && row.source_file_key === 'sheet-shared.csv'))
  })

  it('does not mutate a shift handover when an assigned non-owner submits deletion', async () => {
    let h = harness({ shiftOwnerId: 'owner-user' }), auth = await browser(h)
    h.handovers.set('attached-handover', {
      id: 'attached-handover', source_handover_id: null, shift_id: h.shift.id, source_shift_id: null,
      audio_blob_key: 'audio-initial.webm',
    })
    let body = new FormData()
    body.set('_csrf', auth.token)

    let response = await h.router.fetch(new Request('http://localhost' + routes.actions.deleteShift.href({ shiftId: h.shift.id }), {
      method: 'POST', headers: { cookie: auth.cookie, origin: 'http://localhost' }, body,
    }))

    assert.equal(response.status, 404)
    assert.deepEqual(h.handovers.get('attached-handover'), {
      id: 'attached-handover', source_handover_id: null, shift_id: h.shift.id, source_shift_id: null,
      audio_blob_key: 'audio-initial.webm',
    })
    assert.deepEqual(h.audio.deleted, [])
  })
})
