import { createHash, randomUUID } from 'node:crypto'
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { sql } from 'remix/data-table'
import {
  createAssignment,
  createDataRuntime,
  getHandoverTranscriptPrivacyAuditForUser,
  handoversHaveLocalFirstProcessingHistory,
  listPendingAssignmentsForUser,
  updateHandoverReviewMetadata,
} from '../../app/data/index.ts'

describe('recipient handover isolation', () => {
  it('loads only unactioned assignments for the inbox', async () => {
    let query: Record<string, unknown> | undefined
    let db = {
      async findMany(_table: unknown, options: Record<string, unknown>) {
        query = options
        return []
      },
    }

    await listPendingAssignmentsForUser(db as never, 'recipient')

    assert.deepEqual(query, {
      where: { assigned_to_user_id: 'recipient', status: 'pending' },
      orderBy: ['updated_at', 'desc'],
    })
  })

  it('patches clinician metadata against the latest locked analysis', async () => {
    let now = new Date('2026-07-13T04:30:00.000Z')
    let existing = {
      id: 'handover-1', created_by_user_id: 'user-1', source_handover_id: null, shift_id: null, source_shift_id: null,
      title: 'Outgoing handover · Old name', direction: 'outgoing', source_department: 'Ward', destination_department: '',
      context_type: 'short-transfer', linked_patient_key: 'patient-1', linked_patient_display_name: 'Old name', linked_patient_location: 'Old bed',
      participants: [{ name: 'Old participant' }], participants_edited: false, shared_with_user_ids: [], consent_mode: 'agreed', priority_preference: 'balanced', notes: '',
      audio_blob_key: null, audio_content_type: null, audio_original_filename: null, audio_size_bytes: null, transcript: '', transcription_metadata: null,
      analysis: { participants: ['Old participant'], patients: [{ patientKey: 'patient-1', displayName: 'Old name', location: 'Old bed', uncertainties: [] }] },
      processing_status: 'completed', processing_started_at: now, error_message: null, version: 1, current_job_id: null, processing_lease_until: null,
      created_at: now, updated_at: now,
    }
    let latest = {
      ...existing,
      analysis: {
        ...existing.analysis,
        structuredSummary: {
          situation: 'Current situation.',
          background: 'Current background.',
          assessment: 'Current assessment.',
          recommendation: 'A summary edit committed while the metadata form was open.',
        },
        checklistFocus: [{ id: 'check-1', label: 'Identity', status: 'addressed' }],
      },
    }
    let update: Record<string, unknown> | undefined
    let patientUpdateCount = 0
    let transactionExecCount = 0
    let db = {
      // This stale row is what the pre-fix authorization read observed. The
      // transaction must ignore it and lock/re-read `latest` instead.
      async exec() { return { rows: [existing] } },
      async transaction(callback: (tx: any) => Promise<any>) {
        return callback({
          async update(_table: unknown, _id: string, value: Record<string, unknown>) {
            update = value
            return { ...latest, ...value }
          },
          async exec() {
            transactionExecCount++
            if (transactionExecCount === 1) return { rows: [latest] }
            patientUpdateCount++
            return { rows: [] }
          },
        })
      },
    }

    let saved = await updateHandoverReviewMetadata(db as never, {
      id: existing.id,
      userId: 'user-1',
      participants: ['Casey Bennett', 'Casey Bennett', 'Jordan Day'],
      patients: [{ patientKey: 'patient-1', displayName: 'Arthur Dent', location: 'Bed 12' }],
    })

    assert.ok(saved)
    assert.equal(update?.title, 'Delivering handover · Arthur Dent')
    assert.deepEqual(update?.participants, [{ name: 'Casey Bennett' }, { name: 'Jordan Day' }])
    assert.equal(update?.participants_edited, true)
    assert.equal(update?.linked_patient_display_name, 'Arthur Dent')
    assert.equal((update?.analysis as any).patients[0].location, 'Bed 12')
    assert.equal(
      (update?.analysis as any).structuredSummary.recommendation,
      'A summary edit committed while the metadata form was open.',
    )
    assert.equal((update?.analysis as any).checklistFocus[0].status, 'addressed')
    assert.equal((saved?.analysis as any).structuredSummary.recommendation, 'A summary edit committed while the metadata form was open.')
    assert.equal(patientUpdateCount, 1)
  })

  it('does not mark unchanged participants edited during patient-only metadata saves', async () => {
    for (let alreadyEdited of [false, true]) {
      let existing = {
        id: 'handover-1', created_by_user_id: 'user-1', title: 'Outgoing handover · Old name',
        direction: 'outgoing', linked_patient_key: 'patient-1',
        linked_patient_display_name: 'Old name', linked_patient_location: 'Old bed',
        participants: [{ name: 'Nurse Avery' }, { name: 'Registered Nurse' }],
        participants_edited: alreadyEdited, shared_with_user_ids: [], transcription_metadata: null,
        analysis: null,
      }
      let update: Record<string, unknown> | undefined
      let db = {
        async transaction(callback: (tx: any) => Promise<any>) {
          return callback({
            async update(_table: unknown, _id: string, value: Record<string, unknown>) {
              update = value
              return { ...existing, ...value }
            },
            async exec() { return update ? { rows: [] } : { rows: [existing] } },
          })
        },
      }

      await updateHandoverReviewMetadata(db as never, {
        id: existing.id,
        userId: 'user-1',
        participants: ['Nurse Avery', 'Registered Nurse'],
        patients: [{ patientKey: 'patient-1', displayName: 'Molly Harper', location: 'Bed 12' }],
      })

      assert.equal(update?.participants_edited, alreadyEdited)
      assert.equal(update?.linked_patient_display_name, 'Molly Harper')
    }
  })

  it('durably distinguishes patient-only metadata saves from participant edits before worker claim', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let userId = randomUUID(), handoverId = randomUUID(), jobId = randomUUID()
    try {
      await runtime.db.exec(sql`
        insert into users(id,full_name,occupation,department)
        values(${userId},'Nurse Avery','Registered Nurse','Ward')
      `)
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,title,source_department,context_type,consent_mode,
          priority_preference,linked_patient_key,linked_patient_display_name,
          linked_patient_location,participants,processing_status,current_job_id
        ) values(
          ${handoverId},${userId},'Receiving handover','Ward','short-transfer','agreed',
          'balanced','patient-1','Old name','Old bed',
          ${JSON.stringify([{ name: 'Nurse Avery' }, { name: 'Registered Nurse' }])}::jsonb,
          'queued',${jobId}
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(id,handover_id,revision,kind,status,payload)
        values(${jobId},${handoverId},1,'create','queued','{}'::jsonb)
      `)

      let patientOnlySave = await updateHandoverReviewMetadata(runtime.db, {
        id: handoverId,
        userId,
        participants: ['Nurse Avery', 'Registered Nurse'],
        patients: [{ patientKey: 'patient-1', displayName: 'Molly Harper', location: 'Bed 12' }],
      })
      let patientOnlyRow = (await runtime.db.exec(sql`
        select participants_edited, linked_patient_display_name, linked_patient_location
        from handovers where id=${handoverId}
      `)).rows?.[0]

      assert.ok(patientOnlySave)
      assert.equal(patientOnlyRow?.participants_edited, false)
      assert.equal(patientOnlyRow?.linked_patient_display_name, 'Molly Harper')
      assert.equal(patientOnlyRow?.linked_patient_location, 'Bed 12')

      let participantSave = await updateHandoverReviewMetadata(runtime.db, {
        id: handoverId,
        userId,
        participants: ['Nurse Avery', 'Receiving registrar'],
        patients: [],
      })
      let row = (await runtime.db.exec(sql`
        select participants, participants_edited from handovers where id=${handoverId}
      `)).rows?.[0]

      assert.ok(participantSave)
      assert.equal(row?.participants_edited, true)
      assert.deepEqual(row?.participants, [
        { name: 'Nurse Avery' },
        { name: 'Receiving registrar' },
      ])
    } finally {
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.db.exec(sql`delete from users where id=${userId}`)
      await runtime.close()
    }
  })

  it('copies tasks, remaps uncertainty links, and clones the exact active job contract', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime(), sender = randomUUID(), recipient = randomUUID(), handover = randomUUID(), task = randomUUID(), job = randomUUID()
    try {
      for (let id of [sender, recipient]) await runtime.db.exec(sql`insert into users(id,full_name,occupation,department) values(${id},${id},'Nurse','Ward')`)
      let analysis = { patients: [{ tasks: [{ id: task, title: 'Source task' }], uncertainties: [{ id: 'u1', linkedTaskId: task }] }] }
      let payload = { audioBlobKey: 'active-source.webm', audioOriginalFilename: 'active-source.webm' }
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,title,source_department,context_type,consent_mode,
          priority_preference,analysis,processing_status,current_job_id,version,privacy_mode_floor
        ) values(
          ${handover},${sender},'Source','Ward','shift','verbal','standard',
          ${JSON.stringify(analysis)}::jsonb,'analysing',${job},3,'local-first'
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_tasks(id,handover_id,patient_key,title,due_label,priority,status,source)
        values(${task},${handover},'patient','Source task','today','high','open','transcript')
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(id,handover_id,revision,kind,status,payload)
        values(${job},${handover},3,'extend','running',${JSON.stringify(payload)}::jsonb)
      `)
      let assignment = await createAssignment(runtime.db, { id: randomUUID(), handoverId: handover, assignedByUserId: sender, assignedToUserId: recipient })
      assert.ok(assignment)
      assert.notEqual(assignment.handover_id, handover)
      let copy = (await runtime.db.exec(sql`select * from handovers where id=${assignment.handover_id}`)).rows![0]!
      let copiedTask = (await runtime.db.exec(sql`select * from handover_tasks where handover_id=${assignment.handover_id}`)).rows![0]!
      assert.notEqual(copiedTask.id, task)
      let copiedPatient = (copy.analysis as { patients: Array<{ tasks: Array<{ id: string }>; uncertainties: Array<{ linkedTaskId: string }> }> }).patients[0]!
      assert.equal(copiedPatient.tasks[0]!.id, copiedTask.id)
      assert.equal(copiedPatient.uncertainties[0]!.linkedTaskId, copiedTask.id)
      let copiedJobs = (await runtime.db.exec(sql`select * from handover_jobs where handover_id=${assignment.handover_id}`)).rows!
      assert.equal(copiedJobs.length, 1)
      assert.equal(copiedJobs[0]!.status, 'queued')
      assert.equal(copiedJobs[0]!.revision, 3)
      assert.equal(copiedJobs[0]!.kind, 'extend')
      assert.deepEqual(copiedJobs[0]!.payload, { ...payload, privacyMode: 'local-first' })
      assert.equal(copy.privacy_mode_floor, 'local-first')
      assert.equal(copy.current_job_id, copiedJobs[0]!.id)
      assert.equal(copy.processing_status, 'queued')
      await runtime.db.exec(sql`update handover_tasks set status='done' where id=${String(copiedTask.id)}`)
      assert.equal((await runtime.db.exec(sql`select status from handover_tasks where id=${task}`)).rows![0]!.status, 'open')
    } finally {
      await runtime.db.exec(sql`delete from handovers where id=${handover} or source_handover_id=${handover}`)
      await runtime.db.exec(sql`delete from users where id in (${sender},${recipient})`)
      await runtime.close()
    }
  })

  it('clones an analysis-only active job without copying audio that is no longer needed', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let sender = randomUUID(), recipient = randomUUID(), handover = randomUUID(), job = randomUUID()
    let cleanupId = randomUUID()
    let blobKey = `${randomUUID()}.webm`
    try {
      for (let id of [sender, recipient]) await runtime.db.exec(sql`insert into users(id,full_name,occupation,department) values(${id},${id},'Nurse','Ward')`)
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,title,source_department,context_type,consent_mode,priority_preference,
          transcript,transcription_metadata,processing_status,current_job_id,version,audio_blob_key,
          audio_content_type,audio_original_filename,audio_size_bytes,privacy_mode_floor
        ) values(
          ${handover},${sender},'Analysing source','Ward','shift','verbal','standard',
          'Durable transcript',${JSON.stringify({ engine: 'assemblyai', mocked: false })}::jsonb,
          'analysing',${job},2,${blobKey},'audio/webm','source.webm',256,'local-first'
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_audio(id,handover_id,revision,purpose,blob_key,content_type,original_filename,size_bytes)
        values(${randomUUID()},${handover},2,'initial',${blobKey},'audio/webm','source.webm',256)
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(id,handover_id,revision,kind,status,payload)
        values(${job},${handover},2,'create','running',
          ${JSON.stringify({
            retryFrom: 'analysis',
            audioBlobKey: blobKey,
            audioOriginalFilename: 'source.webm',
            audioCleanupJobId: job,
            privacyMode: 'local-first',
            privacyPolicyVersion: 1,
          })}::jsonb)
      `)
      await runtime.db.exec(sql`
        insert into resource_cleanup_outbox(
          id,kind,resource_id,blob_key,handover_id,job_id,revision,deletion_required
        ) values(
          ${cleanupId},'local-audio-object',${blobKey},${blobKey},${handover},${job},2,true
        )
      `)

      let assignment = await createAssignment(runtime.db, {
        id: randomUUID(), handoverId: handover, assignedByUserId: sender, assignedToUserId: recipient,
      })
      assert.ok(assignment)
      let copy = (await runtime.db.exec(sql`select * from handovers where id=${assignment.handover_id}`)).rows![0]!
      let copiedJob = (await runtime.db.exec(sql`select * from handover_jobs where handover_id=${assignment.handover_id}`)).rows![0]!
      assert.equal(copy.processing_status, 'queued')
      assert.equal(copy.audio_blob_key, null)
      assert.equal(copy.transcript, 'Durable transcript')
      assert.deepEqual(copiedJob.payload, {
        retryFrom: 'analysis',
        audioCleanupJobId: job,
        privacyMode: 'local-first',
        privacyPolicyVersion: 1,
      })
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int as count from handover_audio where handover_id=${assignment.handover_id}
      `)).rows![0]!.count, 0)
      await runtime.db.exec(sql`delete from handovers where id=${handover}`)
      let durableCleanup = (await runtime.db.exec(sql`
        select job_id, deletion_required from resource_cleanup_outbox where id=${cleanupId}
      `)).rows?.[0]
      assert.equal(durableCleanup?.job_id, job)
      assert.equal(durableCleanup?.deletion_required, true)
    } finally {
      await runtime.db.exec(sql`delete from resource_cleanup_outbox where id=${cleanupId}`)
      await runtime.db.exec(sql`delete from handovers where id=${handover} or source_handover_id=${handover}`)
      await runtime.db.exec(sql`delete from users where id in (${sender},${recipient})`)
      await runtime.close()
    }
  })

  it('re-reads a completed source under lock and never queues a fallback empty job', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let sender = randomUUID(), recipient = randomUUID(), handover = randomUUID(), job = randomUUID()
    let blocker = await runtime.pool.connect()
    let blockerOpen = false
    let assignmentPromise: ReturnType<typeof createAssignment> | null = null
    try {
      for (let id of [sender, recipient]) await runtime.db.exec(sql`insert into users(id,full_name,occupation,department) values(${id},${id},'Nurse','Ward')`)
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,title,source_department,context_type,consent_mode,priority_preference,
          analysis,processing_status,current_job_id,version,audio_blob_key,audio_content_type,
          audio_original_filename,audio_size_bytes
        ) values(
          ${handover},${sender},'Source','Ward','shift','verbal','standard',
          ${JSON.stringify({ marker: 'stale-analysis' })}::jsonb,'analysing',${job},2,
          'race-source.webm','audio/webm','race-source.webm',256
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_audio(id,handover_id,revision,purpose,blob_key,content_type,original_filename,size_bytes)
        values(${randomUUID()},${handover},2,'initial','race-source.webm','audio/webm','race-source.webm',256)
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(id,handover_id,revision,kind,status,payload)
        values(${job},${handover},2,'create','running',${JSON.stringify({ audioBlobKey: 'race-source.webm' })}::jsonb)
      `)

      await blocker.query('begin')
      blockerOpen = true
      await blocker.query(`set local lock_timeout='3s'`)
      await blocker.query('select id from handovers where id=$1 for update', [handover])

      let enteredTransaction!: () => void
      let transactionEntered = new Promise<void>((resolve) => { enteredTransaction = resolve })
      let assignmentDb = new Proxy(runtime.db, {
        get(target, property, receiver) {
          if (property === 'transaction') {
            return async (callback: (tx: Parameters<Parameters<typeof runtime.db.transaction>[0]>[0]) => Promise<unknown>) => target.transaction(async (tx) => {
              enteredTransaction()
              return callback(tx)
            })
          }
          let value = Reflect.get(target, property, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })

      assignmentPromise = createAssignment(assignmentDb, {
        id: randomUUID(), handoverId: handover, assignedByUserId: sender, assignedToUserId: recipient,
      })
      await transactionEntered

      await blocker.query(`update handover_jobs set status='completed', payload='{}'::jsonb where id=$1`, [job])
      await blocker.query(`
        update handovers set
          processing_status='completed', processing_started_at=null, analysis=$2::jsonb,
          audio_blob_key=null, audio_content_type=null, audio_original_filename=null, audio_size_bytes=null
        where id=$1
      `, [handover, JSON.stringify({ marker: 'latest-analysis' })])
      await blocker.query('delete from handover_audio where handover_id=$1', [handover])
      await blocker.query('commit')
      blockerOpen = false

      let assignment = await assignmentPromise
      assert.ok(assignment)
      let copy = (await runtime.db.exec(sql`select * from handovers where id=${assignment.handover_id}`)).rows![0]!
      assert.equal(copy.processing_status, 'completed')
      assert.equal(copy.current_job_id, null)
      assert.equal((copy.analysis as { marker: string }).marker, 'latest-analysis')
      assert.equal(copy.audio_blob_key, null)
      assert.equal((await runtime.db.exec(sql`select count(*)::int count from handover_jobs where handover_id=${assignment.handover_id}`)).rows![0]!.count, 0)
      assert.equal((await runtime.db.exec(sql`select count(*)::int count from handover_audio where handover_id=${assignment.handover_id}`)).rows![0]!.count, 0)
    } finally {
      if (blockerOpen) await blocker.query('rollback')
      blocker.release()
      if (assignmentPromise) await assignmentPromise.catch(() => null)
      await runtime.db.exec(sql`delete from handovers where id=${handover} or source_handover_id=${handover}`)
      await runtime.db.exec(sql`delete from users where id in (${sender},${recipient})`)
      await runtime.close()
    }
  })

  it('copies a completed review without retaining the sender raw audio', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let sender = randomUUID(), recipient = randomUUID(), handover = randomUUID(), blobKey = `${randomUUID()}.webm`
    try {
      for (let id of [sender, recipient]) await runtime.db.exec(sql`insert into users(id,full_name,occupation,department) values(${id},${id},'Nurse','Ward')`)
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,title,source_department,context_type,consent_mode,priority_preference,
          analysis,transcript,processing_status,version,audio_blob_key,audio_content_type,
          audio_original_filename,audio_size_bytes
        ) values(
          ${handover},${sender},'Completed source','Ward','shift','verbal','standard',
          ${JSON.stringify({ marker: 'completed-review' })}::jsonb,'Durable transcript','completed',1,
          ${blobKey},'audio/webm','source.webm',256
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_audio(id,handover_id,revision,purpose,blob_key,content_type,original_filename,size_bytes)
        values(${randomUUID()},${handover},1,'initial',${blobKey},'audio/webm','source.webm',256)
      `)

      let assignment = await createAssignment(runtime.db, {
        id: randomUUID(), handoverId: handover, assignedByUserId: sender, assignedToUserId: recipient,
      })
      assert.ok(assignment)
      let copy = (await runtime.db.exec(sql`select * from handovers where id=${assignment.handover_id}`)).rows![0]!
      assert.equal(copy.processing_status, 'completed')
      assert.equal(copy.audio_blob_key, null)
      assert.equal(copy.transcript, 'Durable transcript')
      assert.equal((copy.analysis as { marker: string }).marker, 'completed-review')
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int as count from handover_audio where handover_id=${assignment.handover_id}
      `)).rows![0]!.count, 0)
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int as count from handover_jobs where handover_id=${assignment.handover_id}
      `)).rows![0]!.count, 0)
      assert.equal((await runtime.db.exec(sql`
        select audio_blob_key from handovers where id=${handover}
      `)).rows![0]!.audio_blob_key, blobKey)
    } finally {
      await runtime.db.exec(sql`delete from handovers where id=${handover} or source_handover_id=${handover}`)
      await runtime.db.exec(sql`delete from users where id in (${sender},${recipient})`)
      await runtime.close()
    }
  })

  it('preserves completed local-first provenance after the source handover is deleted', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let sender = randomUUID(), recipient = randomUUID(), handover = randomUUID()
    let jobId = randomUUID(), runId = randomUUID(), auditId = randomUUID(), requestId = randomUUID()
    let exceptionId = randomUUID()
    let copyId: string | null = null
    let transcript = 'Bill Lawrence is stable.'
    let deidentified = '[PERSON_1] is stable.'
    try {
      for (let id of [sender, recipient]) {
        await runtime.db.exec(sql`insert into users(id,full_name,occupation,department) values(${id},${id},'Nurse','Ward')`)
      }
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,title,source_department,context_type,consent_mode,
          priority_preference,transcript,processing_status,version,privacy_mode_floor
        ) values(
          ${handover},${sender},'Completed local-first source','Ward','shift','verbal',
          'standard',${transcript},'completed',1,'local-first'
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(id,handover_id,revision,kind,status,payload)
        values(${jobId},${handover},1,'create','completed',
          ${JSON.stringify({ privacyMode: 'local-first', privacyPolicyVersion: 1 })}::jsonb)
      `)
      await runtime.db.exec(sql`
        insert into analysis_runs(
          id,handover_id,job_id,revision,provider,status,metadata,started_at,completed_at
        ) values(
          ${runId},${handover},${jobId},1,'openai+dspy','completed','{}'::jsonb,now(),now()
        )
      `)
      await runtime.db.exec(sql`
        insert into local_privacy_audits(
          id,context_type,handover_id,job_id,analysis_run_id,revision,
          initiated_by_user_id,source_text,source_sha256,source_utf8_bytes,
          deidentified_text,deidentified_sha256,deidentified_utf8_bytes,
          openmed_deidentified_text,openmed_deidentified_sha256,
          openmed_deidentified_utf8_bytes,applied_exception_count,
          openmed_model_id,openmed_model_revision,openmed_sdk_version,
          openmed_backend,deidentification_method,deidentification_policy,
          offline,smart_merging,safety_sweep,replacement_count
        ) values(
          ${auditId},'handover-dspy',${handover},${jobId},${runId},1,${sender},
          ${transcript},${createHash('sha256').update(transcript).digest('hex')},
          ${Buffer.byteLength(transcript)},${deidentified},
          ${createHash('sha256').update(deidentified).digest('hex')},
          ${Buffer.byteLength(deidentified)},${deidentified},
          ${createHash('sha256').update(deidentified).digest('hex')},
          ${Buffer.byteLength(deidentified)},1,
          'OpenMed/test-model','revision-1','2.2.0',
          'mlx','replace','strict_no_leak',true,true,true,1
        )
      `)
      await runtime.db.exec(sql`
        insert into local_privacy_findings(
          audit_id,ordinal,label,entity_type,canonical_label,original_text,
          replacement_text,start_codepoint,end_codepoint,confidence,threshold,
          sources,action
        ) values(
          ${auditId},0,'FIRST_NAME','PERSON','person','Bill Lawrence',
          '[PERSON_1]',0,13,0.99,0.7,'["model"]'::jsonb,'mask'
        )
      `)
      await runtime.db.exec(sql`
        insert into local_privacy_exceptions(
          id,handover_family_id,normalized_text,canonical_label,
          source_handover_id,source_audit_id,source_finding_ordinal,
          source_original_text,created_by_user_id
        ) values(
          ${exceptionId},${handover},'Bill Lawrence','person',${handover},
          ${auditId},0,'Bill Lawrence',${sender}
        )
      `)
      await runtime.db.exec(sql`
        insert into local_privacy_audit_applied_exceptions(
          audit_id,finding_ordinal,exception_id
        ) values(${auditId},0,${exceptionId})
      `)
      await runtime.db.exec(sql`
        insert into local_privacy_audit_audio_cleanup_dependencies(
          audit_id,cleanup_job_id,cleanup_revision
        ) values(${auditId},${jobId},1)
      `)
      await runtime.db.exec(sql`
        insert into local_privacy_cloud_requests(
          id,audit_id,target_kind,target_name,provider,model,status,
          prepared_at,dispatch_started_at,completed_at,updated_at
        ) values(
          ${requestId},${auditId},'dspy-predict','/predict/checklist','openai',
          'openai/gpt-5.2','completed',now(),now(),now(),now()
        )
      `)

      let assignment = await createAssignment(runtime.db, {
        id: randomUUID(), handoverId: handover, assignedByUserId: sender, assignedToUserId: recipient,
      })
      assert.ok(assignment)
      copyId = assignment.handover_id
      await runtime.db.exec(sql`delete from handovers where id=${handover}`)

      let copy = (await runtime.db.exec(sql`
        select source_handover_id, privacy_mode_floor from handovers where id=${copyId}
      `)).rows?.[0]
      assert.equal(copy?.source_handover_id, handover)
      assert.equal(copy?.privacy_mode_floor, 'local-first')
      assert.equal(await handoversHaveLocalFirstProcessingHistory(runtime.db, [copyId]), true)
      let privacyAudit = await getHandoverTranscriptPrivacyAuditForUser(runtime.db, {
        handoverId: copyId,
        userId: recipient,
      })
      assert.equal(privacyAudit?.modelId, 'OpenMed/test-model')
      assert.equal(privacyAudit?.rerunRequired, false)
      assert.equal(privacyAudit?.findings[0]?.allowedInAnalysis, true)
      assert.deepEqual(privacyAudit?.findings.map((finding) =>
        [...transcript].slice(finding.startCodepoint, finding.endCodepoint).join('')),
      ['Bill Lawrence'])
      let copiedAudit = (await runtime.db.exec(sql`
        select deidentified_text,openmed_deidentified_text,applied_exception_count,
          copied_from_audit_id from local_privacy_audits
        where handover_id = ${copyId}
      `)).rows?.[0]
      assert.deepEqual(copiedAudit, {
        deidentified_text: deidentified,
        openmed_deidentified_text: deidentified,
        applied_exception_count: 1,
        copied_from_audit_id: auditId,
      })
      let copiedApplied = (await runtime.db.exec(sql`
        select applied.exception_id,applied.finding_ordinal
        from local_privacy_audit_applied_exceptions applied
        join local_privacy_audits audit on audit.id = applied.audit_id
        where audit.handover_id = ${copyId}
      `)).rows?.[0]
      assert.deepEqual(copiedApplied, { exception_id: exceptionId, finding_ordinal: 0 })
      let copiedCleanupDependency = (await runtime.db.exec(sql`
        select dependency.cleanup_job_id,dependency.cleanup_revision
        from local_privacy_audit_audio_cleanup_dependencies dependency
        join local_privacy_audits audit on audit.id = dependency.audit_id
        where audit.handover_id = ${copyId}
      `)).rows?.[0]
      assert.deepEqual(copiedCleanupDependency, { cleanup_job_id: jobId, cleanup_revision: 1 })
      assert.deepEqual((await runtime.db.exec(sql`
        select source_audit_id,source_finding_ordinal
        from local_privacy_exceptions where id=${exceptionId}
      `)).rows?.[0], { source_audit_id: null, source_finding_ordinal: null })
      let copiedRequest = (await runtime.db.exec(sql`
        select request.target_kind,request.target_name,request.provider,request.model,
          request.status,request.copied_from_request_id
        from local_privacy_cloud_requests request
        join local_privacy_audits audit on audit.id = request.audit_id
        where audit.handover_id = ${copyId}
      `)).rows?.[0]
      assert.deepEqual(copiedRequest, {
        target_kind: 'dspy-predict',
        target_name: '/predict/checklist',
        provider: 'openai',
        model: 'openai/gpt-5.2',
        status: 'completed',
        copied_from_request_id: requestId,
      })
    } finally {
      if (copyId) await runtime.db.exec(sql`delete from handovers where id=${copyId}`)
      await runtime.db.exec(sql`delete from local_privacy_exceptions where id=${exceptionId}`)
      await runtime.db.exec(sql`delete from handovers where id=${handover}`)
      await runtime.db.exec(sql`delete from users where id in (${sender},${recipient})`)
      await runtime.close()
    }
  })
})
