import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'

import * as assert from 'remix/assert'
import { sql } from 'remix/data-table'
import { describe, it } from 'remix/test'

import {
  allowHandoverPrivacyFindingsForUser,
  createAssignment,
  createDataRuntime,
  deleteHandoverAndCollectOrphanedAudioKeys,
  getHandoverTranscriptPrivacyAuditForUser,
  listActiveHandoverPrivacyExceptions,
  queueHandoverPrivacyReanalysisForUser,
} from '../../app/data/index.ts'

describe('persistent handover privacy exceptions', () => {
  it('saves without dispatch, carries by exact family key, and queues a cleanup-gated full rerun', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let userId = randomUUID(), handoverId = randomUUID(), recipientId = randomUUID()
    let jobId = randomUUID(), runId = randomUUID(), auditId = randomUUID(), requestId = randomUUID()
    let cleanupId = randomUUID(), blobKey = `${randomUUID()}.webm`, rerunJobId = randomUUID()
    let missingCleanupId = randomUUID(), missingBlobKey = `${randomUUID()}.webm`
    let missingCleanupJobId = `zz-unproven-${randomUUID()}`
    let unprovenRerunJobId = randomUUID()
    let transcript = 'Patient Bill is stable.'
    let deidentified = 'Patient [PERSON] is stable.'
    try {
      await runtime.db.exec(sql`
        insert into users(id,full_name,occupation,department)
        values(${userId},'Test clinician','Nurse','Ward')
      `)
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,title,source_department,context_type,
          consent_mode,priority_preference,transcript,transcription_metadata,
          processing_status,version,current_job_id,privacy_mode_floor
        ) values(
          ${handoverId},${userId},'Privacy exception test','Ward','shift',
          'verbal','standard',${transcript},
          ${JSON.stringify({ engine: 'omi-medical-edge-1:mlx', mocked: false })}::jsonb,
          'completed',1,${jobId},'local-first'
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(id,handover_id,revision,kind,status,payload)
        values(${jobId},${handoverId},1,'create','completed',
          ${JSON.stringify({
            audioBlobKey: blobKey,
            privacyMode: 'local-first',
            privacyPolicyVersion: 1,
          })}::jsonb)
      `)
      await runtime.db.exec(sql`
        insert into transcription_runs(
          id,handover_id,job_id,revision,provider,status,metadata,started_at,completed_at
        ) values(
          ${randomUUID()},${handoverId},${jobId},1,'omi-medical-edge-1:mlx',
          'completed','{}'::jsonb,now(),now()
        )
      `)
      await runtime.db.exec(sql`
        insert into analysis_runs(
          id,handover_id,job_id,revision,provider,status,metadata,started_at,completed_at
        ) values(${runId},${handoverId},${jobId},1,'openai+dspy','completed','{}'::jsonb,now(),now())
      `)
      let sourceHash = createHash('sha256').update(transcript).digest('hex')
      let maskedHash = createHash('sha256').update(deidentified).digest('hex')
      await runtime.db.exec(sql`
        insert into local_privacy_audits(
          id,context_type,handover_id,job_id,analysis_run_id,revision,
          initiated_by_user_id,source_text,source_sha256,source_utf8_bytes,
          deidentified_text,deidentified_sha256,deidentified_utf8_bytes,
          openmed_deidentified_text,openmed_deidentified_sha256,
          openmed_deidentified_utf8_bytes,applied_exception_count,
          openmed_model_id,openmed_sdk_version,openmed_backend,
          deidentification_method,deidentification_policy,offline,
          smart_merging,safety_sweep,replacement_count
        ) values(
          ${auditId},'handover-dspy',${handoverId},${jobId},${runId},1,${userId},
          ${transcript},${sourceHash},${Buffer.byteLength(transcript)},
          ${deidentified},${maskedHash},${Buffer.byteLength(deidentified)},
          ${deidentified},${maskedHash},${Buffer.byteLength(deidentified)},0,
          'OpenMed/test','2.2.0','mlx','replace','strict',true,true,true,1
        )
      `)
      await runtime.db.exec(sql`
        insert into local_privacy_findings(
          audit_id,ordinal,label,entity_type,canonical_label,original_text,
          replacement_text,start_codepoint,end_codepoint,confidence,threshold,sources,action
        ) values(
          ${auditId},0,'FIRST_NAME','NAME','PERSON','Bill','[PERSON]',8,12,
          0.99,0.4,'["model"]'::jsonb,'mask'
        )
      `)
      await runtime.db.exec(sql`
        insert into local_privacy_audit_audio_cleanup_dependencies(
          audit_id,cleanup_job_id,cleanup_revision
        ) values
          (${auditId},${jobId},1),
          (${auditId},${missingCleanupJobId},1)
      `)
      await runtime.db.exec(sql`
        insert into local_privacy_cloud_requests(
          id,audit_id,target_kind,target_name,provider,model,status,
          prepared_at,dispatch_started_at,completed_at,updated_at
        ) values(
          ${requestId},${auditId},'dspy-predict','/predict/checklist','openai','test',
          'completed',now(),now(),now(),now()
        )
      `)

      let allowed = await allowHandoverPrivacyFindingsForUser(runtime.db, {
        handoverId, userId, findingRefs: [{ auditId, ordinal: 0 }],
      })
      assert.deepEqual(allowed, { outcome: 'saved', createdCount: 1, totalCount: 1 })
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int as count from local_privacy_cloud_requests where audit_id=${auditId}
      `)).rows?.[0]?.count, 1)
      let audit = await getHandoverTranscriptPrivacyAuditForUser(runtime.db, { handoverId, userId })
      assert.equal(audit?.findings[0]?.allowedInAnalysis, true)
      assert.equal(audit?.rerunRequired, true)

      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,source_handover_id,title,source_department,
          context_type,consent_mode,priority_preference,transcript,
          processing_status,version,privacy_mode_floor
        ) values(
          ${recipientId},${userId},${handoverId},'Recipient copy','Ward','shift',
          'verbal','standard',${transcript},'completed',1,'local-first'
        )
      `)
      assert.deepEqual(
        await listActiveHandoverPrivacyExceptions(runtime.db, recipientId),
        await listActiveHandoverPrivacyExceptions(runtime.db, handoverId),
      )

      assert.equal(await queueHandoverPrivacyReanalysisForUser(runtime.db, {
        handoverId, userId, jobId: unprovenRerunJobId,
      }), 'cleanup-unproven')
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int as count from handover_jobs where id=${unprovenRerunJobId}
      `)).rows?.[0]?.count, 0)
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int as count from resource_cleanup_outbox
        where job_id=${jobId} and revision=1
      `)).rows?.[0]?.count, 0)
      assert.deepEqual((await runtime.db.exec(sql`
        select version,processing_status,current_job_id from handovers where id=${handoverId}
      `)).rows?.[0], { version: 1, processing_status: 'completed', current_job_id: jobId })

      await runtime.db.exec(sql`
        insert into resource_cleanup_outbox(
          id,kind,resource_id,blob_key,handover_id,job_id,revision,status,
          attempts,outcome,deletion_required,completed_at
        ) values
          (${cleanupId},'local-audio-object',${blobKey},${blobKey},${handoverId},
            ${jobId},1,'completed',1,'deleted',true,now()),
          (${missingCleanupId},'local-audio-object',${missingBlobKey},${missingBlobKey},${handoverId},
            ${missingCleanupJobId},1,'completed',1,'already-missing',true,now())
      `)
      assert.equal(await queueHandoverPrivacyReanalysisForUser(runtime.db, {
        handoverId, userId, jobId: rerunJobId,
      }), 'queued')
      let rerun = (await runtime.db.exec(sql`
        select revision,kind,status,payload from handover_jobs where id=${rerunJobId}
      `)).rows?.[0]
      assert.equal(rerun?.revision, 2)
      assert.equal(rerun?.kind, 'create')
      assert.equal(rerun?.status, 'queued')
      assert.deepEqual((rerun?.payload as Record<string, unknown>).audioCleanupDependencies, [
        { jobId, revision: 1 },
        { jobId: missingCleanupJobId, revision: 1 },
      ])

      assert.deepEqual(
        await deleteHandoverAndCollectOrphanedAudioKeys(runtime.db, { id: handoverId, userId }),
        [],
      )
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int as count from local_privacy_exceptions
        where handover_family_id=${handoverId}
      `)).rows?.[0]?.count, 1)
      assert.deepEqual(
        await deleteHandoverAndCollectOrphanedAudioKeys(runtime.db, { id: recipientId, userId }),
        [],
      )
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int as count from local_privacy_exceptions
        where handover_family_id=${handoverId}
      `)).rows?.[0]?.count, 0)
    } finally {
      await runtime.db.exec(sql`delete from handovers where id in (${recipientId},${handoverId})`)
      await runtime.db.exec(sql`
        delete from resource_cleanup_outbox where id in (${cleanupId},${missingCleanupId})
      `)
      await runtime.db.exec(sql`delete from local_privacy_exceptions where handover_family_id=${handoverId}`)
      await runtime.db.exec(sql`delete from users where id=${userId}`)
      await runtime.close()
    }
  })

  it('rejects an overlapping current OpenMed map before persisting an append-only exception', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let userId = randomUUID(), handoverId = randomUUID(), jobId = randomUUID()
    let runId = randomUUID(), auditId = randomUUID()
    let transcript = 'Julie Smith', masked = '[FULL][FIRST]'
    try {
      await runtime.db.exec(sql`
        insert into users(id,full_name,occupation,department)
        values(${userId},'Overlap Tester','Nurse','Ward')
      `)
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,title,source_department,context_type,
          consent_mode,priority_preference,transcript,transcription_metadata,
          processing_status,version,current_job_id,privacy_mode_floor
        ) values(
          ${handoverId},${userId},'Overlap test','Ward','shift','verbal','standard',
          ${transcript},'{"engine":"manual-entry","mocked":false}'::jsonb,
          'completed',1,${jobId},'local-first'
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(id,handover_id,revision,kind,status,payload)
        values(${jobId},${handoverId},1,'create','completed',
          '{"manualTranscript":"Julie Smith","privacyMode":"local-first","privacyPolicyVersion":1}'::jsonb)
      `)
      await runtime.db.exec(sql`
        insert into analysis_runs(
          id,handover_id,job_id,revision,provider,status,metadata,started_at,completed_at
        ) values(${runId},${handoverId},${jobId},1,'openai+dspy','completed','{}'::jsonb,now(),now())
      `)
      let sourceHash = createHash('sha256').update(transcript).digest('hex')
      let maskedHash = createHash('sha256').update(masked).digest('hex')
      await runtime.db.exec(sql`
        insert into local_privacy_audits(
          id,context_type,handover_id,job_id,analysis_run_id,revision,
          initiated_by_user_id,source_text,source_sha256,source_utf8_bytes,
          deidentified_text,deidentified_sha256,deidentified_utf8_bytes,
          openmed_deidentified_text,openmed_deidentified_sha256,
          openmed_deidentified_utf8_bytes,applied_exception_count,
          openmed_model_id,openmed_sdk_version,openmed_backend,
          deidentification_method,deidentification_policy,offline,
          smart_merging,safety_sweep,replacement_count
        ) values(
          ${auditId},'handover-dspy',${handoverId},${jobId},${runId},1,${userId},
          ${transcript},${sourceHash},${Buffer.byteLength(transcript)},
          ${masked},${maskedHash},${Buffer.byteLength(masked)},
          ${masked},${maskedHash},${Buffer.byteLength(masked)},0,
          'OpenMed/test','2.2.0','mlx','replace','strict',true,true,true,2
        )
      `)
      await runtime.db.exec(sql`
        insert into local_privacy_findings(
          audit_id,ordinal,label,entity_type,canonical_label,original_text,
          replacement_text,start_codepoint,end_codepoint,confidence,threshold,sources,action
        ) values
          (${auditId},0,'PATIENT_NAME','NAME','PERSON','Julie Smith','[FULL]',0,11,
            0.99,0.4,'["model"]'::jsonb,'mask'),
          (${auditId},1,'FIRST_NAME','NAME','FIRST_NAME','Julie','[FIRST]',0,5,
            0.99,0.4,'["model"]'::jsonb,'mask')
      `)

      assert.deepEqual(await allowHandoverPrivacyFindingsForUser(runtime.db, {
        handoverId,
        userId,
        findingRefs: [{ auditId, ordinal: 0 }, { auditId, ordinal: 1 }],
      }), { outcome: 'unsupported' })
      assert.equal((await runtime.db.exec(sql`
        select count(*)::int as count from local_privacy_exceptions
        where handover_family_id=${handoverId}
      `)).rows?.[0]?.count, 0)
    } finally {
      await runtime.db.exec(sql`delete from handovers where id=${handoverId}`)
      await runtime.db.exec(sql`delete from local_privacy_exceptions where handover_family_id=${handoverId}`)
      await runtime.db.exec(sql`delete from users where id=${userId}`)
      await runtime.close()
    }
  })

  it('keeps source audit references bounded across multi-hop recipient copies', async () => {
    if (!process.env.DATABASE_URL) return
    let runtime = createDataRuntime()
    let userIds = Array.from({ length: 6 }, () => randomUUID())
    let sourceId = randomUUID(), jobId = randomUUID(), runId = randomUUID(), auditId = randomUUID()
    let handoverIds: string[] = [sourceId]
    let transcript = 'Patient Bill', masked = 'Patient [PERSON]'
    try {
      for (let [index, userId] of userIds.entries()) {
        await runtime.db.exec(sql`
          insert into users(id,full_name,occupation,department)
          values(${userId},${`Copy user ${index}`},'Nurse','Ward')
        `)
      }
      await runtime.db.exec(sql`
        insert into handovers(
          id,created_by_user_id,title,source_department,context_type,
          consent_mode,priority_preference,transcript,transcription_metadata,
          processing_status,version,current_job_id,privacy_mode_floor
        ) values(
          ${sourceId},${userIds[0]!},'Multi-hop source','Ward','shift','verbal','standard',
          ${transcript},'{"engine":"manual-entry","mocked":false}'::jsonb,
          'completed',1,${jobId},'local-first'
        )
      `)
      await runtime.db.exec(sql`
        insert into handover_jobs(id,handover_id,revision,kind,status,payload)
        values(${jobId},${sourceId},1,'create','completed',
          ${JSON.stringify({
            manualTranscript: transcript,
            privacyMode: 'local-first',
            privacyPolicyVersion: 1,
          })}::jsonb)
      `)
      await runtime.db.exec(sql`
        insert into analysis_runs(
          id,handover_id,job_id,revision,provider,status,metadata,started_at,completed_at
        ) values(${runId},${sourceId},${jobId},1,'openai+dspy','completed','{}'::jsonb,now(),now())
      `)
      let sourceHash = createHash('sha256').update(transcript).digest('hex')
      let maskedHash = createHash('sha256').update(masked).digest('hex')
      await runtime.db.exec(sql`
        insert into local_privacy_audits(
          id,context_type,handover_id,job_id,analysis_run_id,revision,
          initiated_by_user_id,source_text,source_sha256,source_utf8_bytes,
          deidentified_text,deidentified_sha256,deidentified_utf8_bytes,
          openmed_deidentified_text,openmed_deidentified_sha256,
          openmed_deidentified_utf8_bytes,applied_exception_count,
          openmed_model_id,openmed_sdk_version,openmed_backend,
          deidentification_method,deidentification_policy,offline,
          smart_merging,safety_sweep,replacement_count
        ) values(
          ${auditId},'handover-dspy',${sourceId},${jobId},${runId},1,${userIds[0]!},
          ${transcript},${sourceHash},${Buffer.byteLength(transcript)},
          ${masked},${maskedHash},${Buffer.byteLength(masked)},
          ${masked},${maskedHash},${Buffer.byteLength(masked)},0,
          'OpenMed/test','2.2.0','mlx','replace','strict',true,true,true,1
        )
      `)
      await runtime.db.exec(sql`
        insert into local_privacy_findings(
          audit_id,ordinal,label,entity_type,canonical_label,original_text,
          replacement_text,start_codepoint,end_codepoint,confidence,threshold,sources,action
        ) values(
          ${auditId},0,'FIRST_NAME','NAME','PERSON','Bill','[PERSON]',8,12,
          0.99,0.4,'["model"]'::jsonb,'mask'
        )
      `)

      let currentHandoverId: string = sourceId
      for (let index = 1; index < userIds.length; index++) {
        let assignment = await createAssignment(runtime.db, {
          id: randomUUID(),
          handoverId: currentHandoverId,
          assignedByUserId: userIds[index - 1]!,
          assignedToUserId: userIds[index]!,
        })
        assert.ok(assignment)
        currentHandoverId = assignment.handover_id
        handoverIds.push(currentHandoverId)
      }

      let finalAudit = await getHandoverTranscriptPrivacyAuditForUser(runtime.db, {
        handoverId: currentHandoverId,
        userId: userIds.at(-1)!,
      })
      let finding = finalAudit?.findings[0]
      assert.ok(finding)
      assert.ok(finding.sourceAuditId.length < 240)
      assert.equal(finding.sourceAuditId, `recipient-audit:${currentHandoverId}:${auditId}`)
      assert.deepEqual(await allowHandoverPrivacyFindingsForUser(runtime.db, {
        handoverId: currentHandoverId,
        userId: userIds.at(-1)!,
        findingRefs: [{ auditId: finding.sourceAuditId, ordinal: finding.sourceOrdinal }],
      }), { outcome: 'saved', createdCount: 1, totalCount: 1 })
    } finally {
      await runtime.db.exec(sql`delete from handovers where id = any(${handoverIds}::text[])`)
      await runtime.db.exec(sql`delete from local_privacy_exceptions where handover_family_id=${sourceId}`)
      await runtime.db.exec(sql`delete from users where id = any(${userIds}::text[])`)
      await runtime.close()
    }
  })
})
