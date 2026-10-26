import fs from 'node:fs/promises'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

describe('local privacy audit migration', () => {
  it('creates normalized, locally owned audit tables with constrained lifecycle indexes', async () => {
    let upFile = new URL('../../db/migrations/20261026000000_initial_schema/up.sql', import.meta.url)
    let downFile = new URL('../../db/migrations/20261026000000_initial_schema/down.sql', import.meta.url)
    let up = await fs.readFile(upFile, 'utf8')
    let down = await fs.readFile(downFile, 'utf8')

    assert.match(up, /create table local_privacy_audits/i)
    assert.match(up, /source_text text not null/i)
    assert.match(up, /deidentified_text text not null/i)
    assert.match(up, /source_sha256 text not null check/i)
    assert.match(up, /deidentified_sha256 text not null check/i)
    assert.match(up, /source_utf8_bytes bigint not null/i)
    assert.match(up, /deidentified_utf8_bytes bigint not null/i)
    assert.match(up, /context_type in \(\s*'handover-dspy',[\s\S]*'shift-prioritisation'/i)
    assert.match(up, /handover_id text references handovers\(id\) on delete cascade/i)
    assert.match(up, /shift_id text references shifts\(id\) on delete cascade/i)
    assert.match(up, /job_id text references handover_jobs\(id\) on delete set null/i)
    assert.match(up, /analysis_run_id text references analysis_runs\(id\) on delete set null/i)
    assert.match(up, /initiated_by_user_id text references users\(id\) on delete set null/i)

    assert.match(up, /create table local_privacy_findings/i)
    assert.match(up, /primary key \(audit_id, ordinal\)/i)
    assert.match(up, /start_codepoint integer not null/i)
    assert.match(up, /end_codepoint integer not null check \(end_codepoint > start_codepoint\)/i)
    assert.match(up, /sources jsonb not null[\s\S]*jsonb_typeof\(sources\) = 'array'/i)

    assert.match(up, /create table local_privacy_cloud_requests/i)
    assert.match(up, /target_kind in \('dspy-predict', 'openai-responses'\)/i)
    assert.match(up, /status in \('prepared', 'dispatching', 'completed', 'failed'\)/i)
    assert.match(up, /unique \(audit_id, target_kind, target_name\)/i)
    assert.match(up, /local_privacy_audits_handover_created_idx/i)
    assert.match(up, /local_privacy_audits_shift_created_idx/i)
    assert.match(up, /local_privacy_audits_job_id_idx/i)
    assert.match(up, /local_privacy_audits_analysis_run_id_idx/i)
    assert.match(up, /local_privacy_audits_initiated_by_user_id_idx/i)
    assert.match(up, /local_privacy_cloud_requests_pending_idx[\s\S]*where status in \('prepared', 'dispatching'\)/i)
    assert.doesNotMatch(up, /mapping_token|\btoken\b/i)

    assert.match(down, /drop table if exists local_privacy_cloud_requests;[\s\S]*local_privacy_findings;[\s\S]*local_privacy_audits;/i)
  })

  it('marks recipient audit copies with durable provenance that survives source deletion', async () => {
    let upFile = new URL('../../db/migrations/20261026000000_initial_schema/up.sql', import.meta.url)
    let up = await fs.readFile(upFile, 'utf8')

    assert.match(up, /copied_from_audit_id text/i)
    assert.match(up, /copied_from_audit_id is null[\s\S]*job_id is null[\s\S]*analysis_run_id is null/i)
    assert.match(up, /unique index local_privacy_audits_recipient_copy_idx/i)
    assert.doesNotMatch(up, /copied_from_audit_id text references/i)
  })

  it('marks copied terminal cloud requests as immutable recipient provenance', async () => {
    let upFile = new URL('../../db/migrations/20261026000000_initial_schema/up.sql', import.meta.url)
    let up = await fs.readFile(upFile, 'utf8')

    assert.match(up, /copied_from_request_id text/i)
    assert.match(up, /copied_from_request_id is null[\s\S]*status in \('completed', 'failed'\)/i)
    assert.match(up, /unique index local_privacy_cloud_requests_recipient_copy_idx/i)
    assert.doesNotMatch(up, /copied_from_request_id text references/i)
  })
})
