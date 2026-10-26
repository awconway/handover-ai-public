import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import * as assert from 'remix/assert'
import { type Database, type SqlStatement } from 'remix/data-table'
import { describe, it } from 'remix/test'

import {
  createLocalPrivacyAuditSink,
  type LocalPrivacyAuditPrepareInput,
} from '../../app/domain/local-privacy-audit.server.ts'

class AuditDatabase {
  statements: Array<{ statement: SqlStatement; inTransaction: boolean }> = []
  transactions = 0
  inTransaction = false
  failPrepare = false
  allowDispatch = true

  async transaction<T>(callback: (db: Database) => Promise<T>): Promise<T> {
    this.transactions += 1
    this.inTransaction = true
    try {
      return await callback(this as unknown as Database)
    } finally {
      this.inTransaction = false
    }
  }

  async exec(statement: SqlStatement | string) {
    if (typeof statement === 'string') return { rows: [] }
    this.statements.push({ statement, inTransaction: this.inTransaction })
    if (this.failPrepare && /insert into local_privacy_audits/i.test(statement.text)) {
      throw new Error('synthetic prepare failure')
    }
    if (/status = 'dispatching'/i.test(statement.text)) {
      return { rows: this.allowDispatch ? [{ id: String(statement.values[0]) }] : [] }
    }
    if (/status = '(?:completed|failed)'/i.test(statement.text)) {
      return { rows: [{ id: String(statement.values[0]) }] }
    }
    return { rows: [] }
  }
}

function prepareInput(): LocalPrivacyAuditPrepareInput {
  return {
    contextType: 'handover-openai',
    sourceText: 'é Julie Smith',
    deidentification: {
      text: 'é Person Alpha',
      replacementCount: 1,
      piiFindings: [{
        originalText: 'Julie Smith',
        label: 'NAME',
        entityType: 'NAME',
        canonicalLabel: 'PERSON',
        start: 2,
        end: 13,
        confidence: 0.98,
        replacementText: 'Person Alpha',
        action: 'replace',
        sources: ['ml'],
        threshold: 0.5,
      }],
      modelId: 'OpenMed/test-mlx',
      sdkVersion: '2.2.0',
      modelRevision: 'abc123',
      backend: 'mlx',
      method: 'replace',
      policy: 'strict_no_leak',
      offline: true,
      smartMerging: true,
      safetySweep: true,
    },
    requests: [{
      targetKind: 'openai-responses',
      targetName: 'base_handover_overview',
      provider: 'openai',
      model: 'gpt-5.5',
    }],
  }
}

describe('local privacy audit sink', () => {
  it('atomically persists exact text, hashes, byte counts, findings, and request plans', async () => {
    let db = new AuditDatabase()
    let sink = createLocalPrivacyAuditSink(db as unknown as Database, {
      handoverId: 'handover-1',
      jobId: 'job-1',
      analysisRunId: 'analysis-job-1-1',
      revision: 1,
      initiatedByUserId: 'user-1',
      audioCleanupDependencies: [{ jobId: 'transcription-job-1', revision: 1 }],
    })
    let input = prepareInput()
    let prepared = await sink.prepare(input)

    assert.equal(db.transactions, 1)
    assert.equal(db.statements.length, 4)
    assert.ok(db.statements.every(({ inTransaction }) => inTransaction))
    assert.match(prepared.auditId, /^local-privacy-audit-\d{17}-[0-9a-f-]{36}$/)
    assert.equal(prepared.requests.length, 1)
    assert.equal(prepared.requests[0]?.targetName, 'base_handover_overview')
    assert.match(prepared.requests[0]?.id ?? '', /^local-privacy-request-\d{17}-[0-9a-f-]{36}$/)

    let auditInsert = db.statements.find(({ statement }) => /insert into local_privacy_audits/i.test(statement.text))?.statement
    assert.ok(auditInsert)
    let sourceDigest = createHash('sha256').update(input.sourceText, 'utf8').digest('hex')
    let safeDigest = createHash('sha256').update(input.deidentification.text, 'utf8').digest('hex')
    assert.ok(auditInsert.values.includes(input.sourceText))
    assert.ok(auditInsert.values.includes(input.deidentification.text))
    assert.ok(auditInsert.values.includes(sourceDigest))
    assert.ok(auditInsert.values.includes(safeDigest))
    assert.ok(auditInsert.values.includes(Buffer.byteLength(input.sourceText, 'utf8')))
    assert.ok(auditInsert.values.includes(Buffer.byteLength(input.deidentification.text, 'utf8')))

    let findingInsert = db.statements.find(({ statement }) => /insert into local_privacy_findings/i.test(statement.text))?.statement
    assert.ok(findingInsert?.values.includes('Julie Smith'))
    assert.ok(findingInsert?.values.includes('Person Alpha'))
    assert.ok(findingInsert?.values.includes(2))
    assert.ok(findingInsert?.values.includes(13))

    let dependencyInsert = db.statements.find(({ statement }) =>
      /insert into local_privacy_audit_audio_cleanup_dependencies/i.test(statement.text))?.statement
    assert.ok(dependencyInsert?.values.includes('transcription-job-1'))
    assert.ok(dependencyInsert?.values.includes(1))
  })

  it('validates the owner, context target, finding count, and Unicode-codepoint span before querying', async () => {
    assert.throws(
      () => createLocalPrivacyAuditSink(new AuditDatabase() as unknown as Database, {}),
      /Exactly one handoverId or shiftId/,
    )
    assert.throws(
      () => createLocalPrivacyAuditSink(new AuditDatabase() as unknown as Database, {
        handoverId: 'handover-1', shiftId: 'shift-1',
      }),
      /Exactly one handoverId or shiftId/,
    )

    let db = new AuditDatabase()
    let sink = createLocalPrivacyAuditSink(db as unknown as Database, { handoverId: 'handover-1' })
    let wrongCount = prepareInput()
    wrongCount.deidentification.replacementCount = 2
    await assert.rejects(() => sink.prepare(wrongCount), /replacementCount/)

    let wrongSpan = prepareInput()
    wrongSpan.deidentification.piiFindings[0]!.start = 1
    await assert.rejects(() => sink.prepare(wrongSpan), /does not match its source span/)

    let wrongTarget = prepareInput()
    wrongTarget.requests[0]!.targetKind = 'dspy-predict'
    await assert.rejects(() => sink.prepare(wrongTarget), /targetKind/)
    assert.equal(db.transactions, 0)
    assert.equal(db.statements.length, 0)
  })

  it('commits the dispatching gate before running an external operation and records completion', async () => {
    let db = new AuditDatabase()
    let sink = createLocalPrivacyAuditSink(db as unknown as Database, { handoverId: 'handover-1' })
    let prepared = await sink.prepare(prepareInput())
    let operationObservedDispatch = false

    let result = await sink.dispatch(prepared.requests[0]!.id, async () => {
      operationObservedDispatch = db.statements.some(({ statement, inTransaction }) =>
        /status = 'dispatching'/i.test(statement.text) && !inTransaction)
      assert.equal(db.inTransaction, false)
      return { ok: true }
    })

    assert.deepEqual(result, { ok: true })
    assert.equal(operationObservedDispatch, true)
    assert.ok(db.statements.some(({ statement, inTransaction }) =>
      /status = 'completed'/i.test(statement.text) && !inTransaction))
  })

  it('does not dispatch when atomic preparation fails', async () => {
    let db = new AuditDatabase()
    db.failPrepare = true
    let sink = createLocalPrivacyAuditSink(db as unknown as Database, { handoverId: 'handover-1' })
    let operationCalled = false

    await assert.rejects(async () => {
      let prepared = await sink.prepare(prepareInput())
      await sink.dispatch(prepared.requests[0]!.id, async () => {
        operationCalled = true
      })
    }, /synthetic prepare failure/)

    assert.equal(operationCalled, false)
    assert.equal(db.statements.some(({ statement }) => /status = 'dispatching'/i.test(statement.text)), false)
  })

  it('records only a safe error type when the operation fails', async () => {
    let db = new AuditDatabase()
    let sink = createLocalPrivacyAuditSink(db as unknown as Database, { handoverId: 'handover-1' })
    let prepared = await sink.prepare(prepareInput())
    let sensitiveMessage = 'Patient Julie Smith must not enter audit errors'

    await assert.rejects(
      () => sink.dispatch(prepared.requests[0]!.id, async () => {
        throw new Error(sensitiveMessage)
      }),
      new RegExp(sensitiveMessage),
    )

    let failed = db.statements.find(({ statement }) => /status = 'failed'/i.test(statement.text))?.statement
    assert.ok(failed)
    assert.ok(failed.values.includes('Error'))
    assert.equal(failed.values.some((value) => String(value).includes(sensitiveMessage)), false)
  })

  it('does not persist an untrusted exception class name as an error type', async () => {
    let db = new AuditDatabase()
    let sink = createLocalPrivacyAuditSink(db as unknown as Database, { handoverId: 'handover-1' })
    let prepared = await sink.prepare(prepareInput())
    let error = new Error('provider failed')
    error.name = 'JulieSmithProviderFailure'

    await assert.rejects(() => sink.dispatch(prepared.requests[0]!.id, async () => { throw error }))

    let failed = db.statements.find(({ statement }) => /status = 'failed'/i.test(statement.text))?.statement
    assert.ok(failed?.values.includes('ApplicationError'))
    assert.equal(failed?.values.includes('JulieSmithProviderFailure'), false)
  })

  it('refuses an unknown or already-dispatched request before calling the operation', async () => {
    let db = new AuditDatabase()
    db.allowDispatch = false
    let sink = createLocalPrivacyAuditSink(db as unknown as Database, { handoverId: 'handover-1' })
    let operationCalled = false

    await assert.rejects(
      () => sink.dispatch('unknown-request', async () => {
        operationCalled = true
      }),
      /not prepared/,
    )
    assert.equal(operationCalled, false)
  })
})
