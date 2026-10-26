import * as assert from 'remix/assert'
import { createHash } from 'node:crypto'
import { type Database, type SqlStatement } from 'remix/data-table'
import { describe, it } from 'remix/test'

import { getHandoverTranscriptPrivacyAuditForUser } from '../../app/data/repository.ts'

class TranscriptPrivacyDatabase {
  statements: SqlStatement[] = []

  constructor(private readonly rows: Record<string, unknown>[] = []) {}

  async exec(statement: SqlStatement | string) {
    assert.notEqual(typeof statement, 'string')
    this.statements.push(statement as SqlStatement)
    return { rows: this.rows }
  }
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function codepointOffset(source: string, value: string) {
  let index = source.indexOf(value)
  if (index < 0) return -1
  return [...source.slice(0, index)].length
}

function auditRow(options: {
  id?: string
  revision?: number
  sourceText?: string
  currentTranscript?: string
  originalText?: string
  findings?: Record<string, unknown>[]
  createdAt?: Date
  activeExceptions?: Record<string, unknown>[]
  appliedExceptionId?: string | null
} = {}) {
  let sourceText = options.sourceText ?? '🩺 Julie Smith is stable.'
  let originalText = options.originalText ?? 'Julie Smith'
  let startCodepoint = codepointOffset(sourceText, originalText)
  let findings = options.findings ?? [{
    ordinal: 0,
    label: 'PATIENT_NAME',
    entityType: 'NAME',
    canonicalLabel: 'person',
    originalText,
    startCodepoint,
    endCodepoint: startCodepoint + [...originalText].length,
    confidence: 0.98,
    sources: ['model'],
    appliedExceptionId: options.appliedExceptionId ?? null,
  }]
  return {
    id: options.id ?? 'audit-1',
    revision: options.revision ?? 1,
    source_text: sourceText,
    source_sha256: sha256(sourceText),
    current_transcript: options.currentTranscript ?? sourceText,
    openmed_model_id: 'OpenMed/superclinical-small',
    openmed_model_revision: 'rev-1',
    openmed_backend: 'mlx',
    deidentification_method: 'token-classification',
    deidentification_policy: 'strict-no-leak',
    offline: true,
    replacement_count: findings.length,
    created_at: options.createdAt ?? new Date('2026-08-26T01:00:00.000Z'),
    active_exceptions: options.activeExceptions ?? [],
    findings,
  }
}

describe('transcript privacy audit read model', () => {
  it('returns only exact, authorized DSPy transcript findings in Unicode codepoint order', async () => {
    let db = new TranscriptPrivacyDatabase([auditRow()])
    let audit = await getHandoverTranscriptPrivacyAuditForUser(
      db as unknown as Database,
      { handoverId: 'handover-1', userId: 'user-1' },
    )

    assert.ok(audit)
    assert.equal(audit.modelId, 'OpenMed/superclinical-small')
    assert.equal(audit.offline, true)
    assert.equal(audit.createdAt, '2026-08-26T01:00:00.000Z')
    assert.deepEqual(audit.findings, [{
      ordinal: 0,
      sourceAuditId: 'audit-1',
      sourceOrdinal: 0,
      allowedInAnalysis: false,
      label: 'PATIENT_NAME',
      entityType: 'NAME',
      canonicalLabel: 'person',
      startCodepoint: 2,
      endCodepoint: 13,
      confidence: 0.98,
      sources: ['model'],
    }])
    assert.equal(audit.rerunRequired, false)
    let statement = db.statements[0]!
    assert.match(statement.text, /audit\.context_type = 'handover-dspy'/)
    assert.match(statement.text, /job\.status = 'completed'/)
    assert.match(statement.text, /run\.status = 'completed'/)
    assert.doesNotMatch(statement.text, /audit\.source_text = handover\.transcript/)
    assert.match(statement.text, /handover\.created_by_user_id/)
    assert.match(statement.text, /handover_assignments assignment/)
    assert.doesNotMatch(statement.text, /deidentified_text/)
    assert.deepEqual(statement.values, ['handover-1', 'user-1', 'user-1', 'user-1', 'user-1', 'user-1'])
  })

  it('marks an exact NFKC family exception stale until applied provenance exists', async () => {
    let active = [{ id: 'exception-1', normalizedText: 'Julie Smith', canonicalLabel: 'person' }]
    let pending = await getHandoverTranscriptPrivacyAuditForUser(
      new TranscriptPrivacyDatabase([auditRow({ activeExceptions: active })]) as unknown as Database,
      { handoverId: 'handover-1', userId: 'user-1' },
    )
    assert.equal(pending?.findings[0]?.allowedInAnalysis, true)
    assert.equal(pending?.rerunRequired, true)

    let applied = await getHandoverTranscriptPrivacyAuditForUser(
      new TranscriptPrivacyDatabase([auditRow({ activeExceptions: active, appliedExceptionId: 'exception-1' })]) as unknown as Database,
      { handoverId: 'handover-1', userId: 'user-1' },
    )
    assert.equal(applied?.findings[0]?.allowedInAnalysis, true)
    assert.equal(applied?.rerunRequired, false)

    let caseMismatch = await getHandoverTranscriptPrivacyAuditForUser(
      new TranscriptPrivacyDatabase([auditRow({ activeExceptions: [{ ...active[0]!, normalizedText: 'julie smith' }] })]) as unknown as Database,
      { handoverId: 'handover-1', userId: 'user-1' },
    )
    assert.equal(caseMismatch?.findings[0]?.allowedInAnalysis, false)
  })

  it('composes completed recommencement audits with exact Unicode-safe offsets', async () => {
    let firstSource = '🩺 Julie is stable.'
    let secondSource = 'e\u0301 Bill needs review.'
    let transcript = `${firstSource}\n${secondSource}`
    let db = new TranscriptPrivacyDatabase([
      auditRow({ id: 'audit-1', revision: 1, sourceText: firstSource, currentTranscript: transcript, originalText: 'Julie' }),
      auditRow({ id: 'audit-2', revision: 2, sourceText: secondSource, currentTranscript: transcript, originalText: 'Bill', createdAt: new Date('2026-08-26T01:05:00.000Z') }),
    ])

    let audit = await getHandoverTranscriptPrivacyAuditForUser(
      db as unknown as Database,
      { handoverId: 'handover-1', userId: 'user-1' },
    )

    assert.ok(audit)
    assert.equal(audit.id, 'audit-2')
    assert.equal(audit.replacementCount, 2)
    assert.equal(audit.createdAt, '2026-08-26T01:05:00.000Z')
    assert.deepEqual(audit.findings.map((finding) => ({
      originalText: [...transcript].slice(finding.startCodepoint, finding.endCodepoint).join(''),
      start: finding.startCodepoint,
      end: finding.endCodepoint,
    })), [
      { originalText: 'Julie', start: 2, end: 7 },
      {
        originalText: 'Bill',
        start: [...`${firstSource}\ne\u0301 `].length,
        end: [...`${firstSource}\ne\u0301 Bill`].length,
      },
    ])
  })

  it('prefers a later whole-transcript audit over older fragments', async () => {
    let firstSource = 'Julie is stable.'
    let secondSource = 'Bill needs review.'
    let transcript = `${firstSource}\n${secondSource}`
    let whole = auditRow({
      id: 'audit-whole',
      revision: 3,
      sourceText: transcript,
      currentTranscript: transcript,
      originalText: 'Bill',
      createdAt: new Date('2026-08-26T01:10:00.000Z'),
    })
    let db = new TranscriptPrivacyDatabase([
      auditRow({ id: 'audit-1', revision: 1, sourceText: firstSource, currentTranscript: transcript, originalText: 'Julie' }),
      auditRow({ id: 'audit-2', revision: 2, sourceText: secondSource, currentTranscript: transcript, originalText: 'Bill' }),
      whole,
    ])

    let audit = await getHandoverTranscriptPrivacyAuditForUser(
      db as unknown as Database,
      { handoverId: 'handover-1', userId: 'user-1' },
    )
    assert.equal(audit?.id, 'audit-whole')
    assert.equal(audit?.replacementCount, 1)
  })

  it('fails closed on malformed, partial, or ambiguous persisted source evidence', async () => {
    let invalid = new TranscriptPrivacyDatabase([auditRow({ originalText: 'Wrong Name' })])
    assert.equal(await getHandoverTranscriptPrivacyAuditForUser(
      invalid as unknown as Database,
      { handoverId: 'handover-1', userId: 'user-1' },
    ), null)

    let missing = new TranscriptPrivacyDatabase()
    assert.equal(await getHandoverTranscriptPrivacyAuditForUser(
      missing as unknown as Database,
      { handoverId: 'handover-1', userId: 'user-1' },
    ), null)

    let transcript = 'First\nSecond'
    let partial = new TranscriptPrivacyDatabase([
      auditRow({ sourceText: 'First', currentTranscript: transcript, findings: [] }),
    ])
    assert.equal(await getHandoverTranscriptPrivacyAuditForUser(
      partial as unknown as Database,
      { handoverId: 'handover-1', userId: 'user-1' },
    ), null)

    let ambiguous = new TranscriptPrivacyDatabase([
      auditRow({ id: 'audit-1a', revision: 1, sourceText: 'First', currentTranscript: transcript, findings: [] }),
      auditRow({ id: 'audit-1b', revision: 1, sourceText: 'First', currentTranscript: transcript, findings: [] }),
      auditRow({ id: 'audit-2', revision: 2, sourceText: 'Second', currentTranscript: transcript, findings: [] }),
    ])
    assert.equal(await getHandoverTranscriptPrivacyAuditForUser(
      ambiguous as unknown as Database,
      { handoverId: 'handover-1', userId: 'user-1' },
    ), null)
  })
})
