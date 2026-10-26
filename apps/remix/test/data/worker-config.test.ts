import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import {
  confirmRequiredPrivacyAudioCleanupDependencies,
  fetchDspyProvenance,
  fullAnalysisRecoveryPrivacyCleanupIsProvable,
  isStoredTranscriptMocked,
  predictWithLocalPrivacy,
  priorPrivacyDenyTerms,
  processingModeForJob,
  processingFailureDiagnostic,
  ratchetPrivacyModeForProcessing,
  resolveWorkerOptions,
} from '../../worker.ts'
import { shiftPrioritisationPrivacySourceIds } from '../../app/domain/shift-prioritisation.server.ts'
import type { LocalDeidentificationAudit } from '../../app/domain/local-privacy.server.ts'
import type {
  LocalPrivacyAuditPrepareInput,
  LocalPrivacyAuditSink,
} from '../../app/domain/local-privacy-audit.server.ts'

const fakeDspyDeidentification: LocalDeidentificationAudit = {
  text: '[PERSON_1] MRN [ID_1]',
  replacementCount: 2,
  piiFindings: [
    {
      originalText: 'Jane Doe',
      label: 'PERSON',
      entityType: 'PERSON',
      canonicalLabel: 'PERSON',
      start: 0,
      end: 8,
      confidence: 0.99,
      replacementText: '[PERSON_1]',
      action: 'mask',
      sources: ['model'],
      threshold: 0.7,
    },
    {
      originalText: '123456',
      label: 'ID_NUM',
      entityType: 'ID_NUM',
      canonicalLabel: 'ID_NUM',
      start: 13,
      end: 19,
      confidence: 0.98,
      replacementText: '[ID_1]',
      action: 'mask',
      sources: ['model'],
      threshold: 0.7,
    },
  ],
  modelId: 'OpenMed/test-model',
  sdkVersion: '2.2.0',
  modelRevision: null,
  backend: 'mlx',
  method: 'replace',
  policy: 'strict_no_leak',
  offline: true,
  smartMerging: true,
  safetySweep: true,
}

describe('durable worker configuration', () => {
  it('carries protected canonical OpenMed labels into recommenced handovers', () => {
    assert.deepEqual(priorPrivacyDenyTerms([
      { original_text: 'Jim', canonical_label: 'FIRST_NAME', entity_type: 'first_name', label: 'first_name' },
      { original_text: 'Burke', canonical_label: 'LAST_NAME', entity_type: 'last_name', label: 'last_name' },
      { original_text: '1 September 2026', canonical_label: 'DATE', entity_type: 'date', label: 'date' },
      { original_text: 'Nurse', canonical_label: 'OCCUPATION', entity_type: 'occupation', label: 'occupation' },
      { original_text: 'Hospital', canonical_label: 'COMPANY_NAME', entity_type: 'PERSON', label: 'person' },
      { original_text: 'MRN-123', canonical_label: null, entity_type: 'ID_NUM', label: 'id_num' },
    ]), [
      { term: 'Jim', label: 'FIRST_NAME' },
      { term: 'Burke', label: 'LAST_NAME' },
      { term: 'MRN-123', label: 'ID_NUM' },
    ])
  })

  it('fails closed for a legacy analysis-only full extension recovery without rollback provenance', () => {
    let base = {
      processingMode: 'local-first' as const,
      analysisMode: 'full' as const,
      jobKind: 'extend' as const,
      analysisRetry: true,
      hasRollbackTranscript: false,
      priorTranscript: null,
      priorDependencies: [],
      rollbackEngine: undefined,
    }
    assert.equal(fullAnalysisRecoveryPrivacyCleanupIsProvable(base), false)
    assert.equal(fullAnalysisRecoveryPrivacyCleanupIsProvable({
      ...base,
      hasRollbackTranscript: true,
    }), true)
    assert.equal(fullAnalysisRecoveryPrivacyCleanupIsProvable({
      ...base,
      hasRollbackTranscript: true,
      priorTranscript: 'Prior transcript',
      priorDependencies: [{ jobId: 'source-job', revision: 1 }],
    }), true)
    assert.equal(fullAnalysisRecoveryPrivacyCleanupIsProvable({
      ...base,
      hasRollbackTranscript: true,
      priorTranscript: 'Manual prior transcript',
      rollbackEngine: 'manual-entry',
    }), true)
  })

  it('confirms every exact prior cleanup dependency and fails closed if any remains unconfirmed', async () => {
    let calls: Array<{ jobId: string; revision: number }> = []
    let dependencies = [
      { jobId: 'source-job-1', revision: 1 },
      { jobId: 'source-job-2', revision: 3 },
    ]
    await confirmRequiredPrivacyAudioCleanupDependencies({
      async confirmRequiredDeletion(input) {
        calls.push(input)
        return { status: 'deleted', referencesCleared: true, cleanupId: `cleanup-${input.jobId}` }
      },
    }, dependencies)
    assert.deepEqual(calls, dependencies)

    calls = []
    await assert.rejects(() => confirmRequiredPrivacyAudioCleanupDependencies({
      async confirmRequiredDeletion(input) {
        calls.push(input)
        return input.jobId === 'source-job-1'
          ? { status: 'deleted', referencesCleared: true, cleanupId: 'cleanup-1' }
          : { status: 'not-eligible', reason: 'job-mismatch' }
      },
    }, dependencies), /source recording deletion is confirmed/)
    assert.deepEqual(calls, dependencies)
  })

  it('tightens queued work without downgrading a snapshotted local-first job', () => {
    assert.equal(processingModeForJob({}, {}), 'cloud')
    assert.equal(processingModeForJob({ privacyMode: 'cloud' }, {
      LOCAL_FIRST_PROCESSING_POLICY: 'required',
    }), 'local-first')
    assert.equal(processingModeForJob({ privacyMode: 'local-first' }, {
      LOCAL_FIRST_PROCESSING_POLICY: 'disabled',
    }), 'local-first')
    assert.equal(processingModeForJob({ privacyMode: 'cloud' }, {
      LOCAL_FIRST_PROCESSING_POLICY: 'disabled',
    }, 'local-first'), 'local-first')
  })

  it('durably ratchets a required upgrade so a later retry cannot return to cloud', () => {
    let queued = { privacyMode: 'cloud' as const, privacyPolicyVersion: 1 as const }
    let effective = processingModeForJob(queued, {
      LOCAL_FIRST_PROCESSING_POLICY: 'required',
    })
    let tightened = ratchetPrivacyModeForProcessing(queued, effective)
    let retry = { ...tightened, retryFrom: 'analysis' as const }

    assert.equal(tightened.privacyMode, 'local-first')
    assert.equal(tightened.privacyPolicyVersion, 1)
    assert.equal(processingModeForJob(retry, {
      LOCAL_FIRST_PROCESSING_POLICY: 'disabled',
    }), 'local-first')
  })

  it('keeps source-shift-only clinical rows in shift privacy provenance', () => {
    assert.deepEqual(shiftPrioritisationPrivacySourceIds({
      allHandovers: [
        { id: 'direct', source_handover_id: null },
        { id: 'source-shift-only', source_handover_id: 'authoritative-source' },
      ],
      shiftHandovers: [{ id: 'direct' }],
      clinicalRows: [{ handover_id: 'source-shift-only' }],
    }), ['direct', 'source-shift-only', 'authoritative-source'])
  })

  it('deidentifies every DSPy request and restores the combined result locally', async () => {
    let predictionInputs: string[] = []
    let result = await predictWithLocalPrivacy({
      async withDeidentifiedText<T>(
        raw: string,
        operation: (safeText: string, deidentification: LocalDeidentificationAudit) => Promise<T>,
      ): Promise<T> {
        assert.equal(raw, 'Jane Doe MRN 123456')
        let protectedValue = await operation('[PERSON_1] MRN [ID_1]', fakeDspyDeidentification)
        return JSON.parse(JSON.stringify(protectedValue).replaceAll('[PERSON_1]', 'Jane Doe')) as T
      },
    }, {
      dspyBaseUrl: 'https://dspy.test',
      dspyTimeoutMs: 10_000,
      dspySharedSecret: 'secret',
    }, 'Jane Doe MRN 123456', async (_baseUrl, path, transcript) => {
      predictionInputs.push(transcript)
      assert.doesNotMatch(transcript, /Jane Doe|123456/)
      return { path, quote: '[PERSON_1]' }
    })

    assert.deepEqual(predictionInputs, [
      '[PERSON_1] MRN [ID_1]',
      '[PERSON_1] MRN [ID_1]',
      '[PERSON_1] MRN [ID_1]',
    ])
    assert.deepEqual(result.checklist, { path: '/predict/checklist', quote: 'Jane Doe' })
    assert.deepEqual(result.sbar, { path: '/predict/sbar', quote: 'Jane Doe' })
    assert.deepEqual(result.unknownFacts, { path: '/predict/unknown-fact', quote: 'Jane Doe' })
  })

  it('prepares one local OpenMed audit before dispatching all three DSPy cloud requests', async () => {
    let preparedInput: LocalPrivacyAuditPrepareInput | undefined
    let dispatched: string[] = []
    let audit: LocalPrivacyAuditSink = {
      async prepare(input) {
        preparedInput = input
        return {
          auditId: 'audit-1',
          requests: input.requests.map((request, index) => ({
            id: `request-${index + 1}`,
            targetName: request.targetName,
          })),
        }
      },
      async dispatch(requestId, operation) {
        dispatched.push(requestId)
        return operation()
      },
    }
    let result = await predictWithLocalPrivacy({
      async withDeidentifiedText<T>(
        raw: string,
        operation: (safeText: string, deidentification: LocalDeidentificationAudit) => Promise<T>,
      ): Promise<T> {
        assert.equal(raw, 'Jane Doe MRN 123456')
        return operation(fakeDspyDeidentification.text, fakeDspyDeidentification)
      },
    }, {
      dspyBaseUrl: 'https://dspy.test',
      dspyTimeoutMs: 10_000,
      dspySharedSecret: 'secret',
    }, 'Jane Doe MRN 123456', async (_baseUrl, path, transcript) => {
      assert.equal(preparedInput?.deidentification.text, transcript)
      return { path, model: 'openai/gpt-5.3-clinical' }
    }, audit, [], async (baseUrl, timeoutMs, secret) => {
      assert.equal(baseUrl, 'https://dspy.test')
      assert.equal(timeoutMs, 10_000)
      assert.equal(secret, 'secret')
      return { provider: 'openai', model: 'openai/gpt-5.3-clinical' }
    })

    if (!preparedInput) throw new Error('Expected the audit to be prepared.')
    assert.equal(preparedInput.contextType, 'handover-dspy')
    assert.equal(preparedInput.sourceText, 'Jane Doe MRN 123456')
    assert.equal(preparedInput.deidentification.piiFindings[0]?.originalText, 'Jane Doe')
    assert.deepEqual(preparedInput.requests.map((request) => ({
      kind: request.targetKind,
      name: request.targetName,
      provider: request.provider,
      model: request.model,
    })), [
      { kind: 'dspy-predict', name: '/predict/checklist', provider: 'openai', model: 'openai/gpt-5.3-clinical' },
      { kind: 'dspy-predict', name: '/predict/sbar', provider: 'openai', model: 'openai/gpt-5.3-clinical' },
      { kind: 'dspy-predict', name: '/predict/unknown-fact', provider: 'openai', model: 'openai/gpt-5.3-clinical' },
    ])
    assert.deepEqual(dispatched, ['request-1', 'request-2', 'request-3'])
    assert.deepEqual(Object.keys(result).sort(), ['checklist', 'sbar', 'unknownFacts'])
  })

  it('fails a local-first DSPy dispatch when a response disagrees with the attested model', async () => {
    let audit: LocalPrivacyAuditSink = {
      async prepare(input) {
        return {
          auditId: 'audit-model-mismatch',
          requests: input.requests.map((request, index) => ({
            id: `request-mismatch-${index}`,
            targetName: request.targetName,
          })),
        }
      },
      async dispatch(_requestId, operation) { return operation() },
    }
    await assert.rejects(
      predictWithLocalPrivacy({
        async withDeidentifiedText<T>(
          _raw: string,
          operation: (safeText: string, deidentification: LocalDeidentificationAudit) => Promise<T>,
        ): Promise<T> {
          return operation(fakeDspyDeidentification.text, fakeDspyDeidentification)
        },
      }, {
        dspyBaseUrl: 'https://dspy.test',
        dspyTimeoutMs: 10_000,
        dspySharedSecret: 'secret',
      }, 'Jane Doe MRN 123456', async (_baseUrl, path) => ({
        path,
        model: path === '/predict/sbar' ? 'openai/different-model' : 'openai/attested-model',
      }), audit, [], async () => ({ provider: 'openai', model: 'openai/attested-model' })),
      /\/predict\/sbar returned mismatched model provenance/,
    )
  })

  it('reads bounded DSPy provenance from the authenticated inference service', async () => {
    let provenance = await fetchDspyProvenance(
      'https://dspy.test',
      5_000,
      'shared-secret',
      async (input, init) => {
        assert.equal(String(input), 'https://dspy.test/provenance')
        assert.equal(init?.method, 'GET')
        assert.equal(new Headers(init?.headers).get('x-handover-worker-token'), 'shared-secret')
        return new Response(JSON.stringify({
          service: 'DSPy test',
          version: '1.0.0',
          provider: 'azure-openai',
          model: 'azure-openai/clinical-deployment-v2',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    )

    assert.deepEqual(provenance, {
      provider: 'azure-openai',
      model: 'azure-openai/clinical-deployment-v2',
    })
    await assert.rejects(
      fetchDspyProvenance('https://dspy.test', 5_000, 'secret', async () =>
        new Response(JSON.stringify({ provider: 'openai', model: 'not a model\nBill Lawrence' }))
      ),
      /\/provenance returned invalid model/,
    )
  })

  it('uses the configured default timeout for required DSPy predictors', () => {
    let options = resolveWorkerOptions({ workerId: 'worker-test' }, {})
    assert.equal(options.dspyTimeoutMs, 60_000)
  })

  it('rejects an invalid privacy policy during worker configuration', () => {
    assert.throws(
      () => resolveWorkerOptions(
        { workerId: 'worker-test' },
        { LOCAL_FIRST_PROCESSING_POLICY: 'requred' },
      ),
      /LOCAL_FIRST_PROCESSING_POLICY must be disabled, optional, or required/,
    )
  })

  it('honours the documented queue and DSPy timeout variables', () => {
    let options = resolveWorkerOptions({ workerId: 'worker-test' }, {
      QUEUE_POLL_INTERVAL_MS: '4321',
      JOB_POLL_INTERVAL_MS: '9999',
      HANDOVER_DSPY_TIMEOUT_MS: '9876',
      HANDOVER_DSPY_API_URL: 'http://dspy.test/',
    })

    assert.equal(options.pollMs, 4321)
    assert.equal(options.dspyTimeoutMs, 9876)
    assert.equal(options.dspyBaseUrl, 'http://dspy.test')
  })

  it('keeps the former job poll variable as a compatibility fallback', () => {
    let options = resolveWorkerOptions({ workerId: 'worker-test' }, { JOB_POLL_INTERVAL_MS: '2468' })
    assert.equal(options.pollMs, 2468)
  })

  it('rejects invalid queue timing', () => {
    assert.throws(
      () => resolveWorkerOptions({ workerId: 'worker-test' }, { QUEUE_POLL_INTERVAL_MS: '0' }),
      /QUEUE_POLL_INTERVAL_MS must be a positive integer/,
    )
  })

  it('recognises metadata-backed and legacy mock transcripts without false positives', () => {
    assert.equal(isStoredTranscriptMocked('Provider transcript.', { mocked: true }), true)
    assert.equal(isStoredTranscriptMocked('Provider transcript.', JSON.stringify({ mocked: true })), true)
    assert.equal(isStoredTranscriptMocked('Mock transcription for audio-object.webm.', null), true)
    assert.equal(isStoredTranscriptMocked('[OUTGOING_NURSE]: Mock transcription for queued handover audio.', null), true)
    assert.equal(isStoredTranscriptMocked('The nurse discussed a mock transcription for training.', null), false)
    assert.equal(isStoredTranscriptMocked('Provider transcript.', { mocked: false }), false)
  })

  it('records bounded failure diagnostics without exception messages or clinical values', () => {
    let error = Object.assign(new Error('Joe Lynch at Bed 2 could not be reconciled.'), {
      name: 'PatientAnalysisReconciliationError',
      code: 'PATIENT_ANALYSIS_RECONCILIATION_FAILED',
    })
    assert.deepEqual(processingFailureDiagnostic(error, 'analysis'), {
      stage: 'analysis',
      errorType: 'PatientAnalysisReconciliationError',
      errorCode: 'PATIENT_ANALYSIS_RECONCILIATION_FAILED',
    })

    let validation = Object.assign(new Error('Invalid patient output'), {
      name: 'ZodError',
      issues: [{ code: 'too_small', path: ['patients', 0, 'summary', 'situation'], message: 'Patient value' }],
    })
    let diagnostic = processingFailureDiagnostic(validation, 'analysis')
    assert.equal(diagnostic.errorCode, 'STRUCTURED_OUTPUT_VALIDATION_FAILED')
    assert.deepEqual(diagnostic.issues, [{ code: 'too_small', path: 'patients.0.summary.situation' }])
    assert.doesNotMatch(JSON.stringify(diagnostic), /Joe Lynch|Bed 2|Patient value/)

    let dspyFailure = Object.assign(new Error('/predict/sbar failed'), {
      name: 'DspyAnalysisError',
      code: 'DSPY_PREDICTION_FAILED',
    })
    assert.deepEqual(processingFailureDiagnostic(dspyFailure, 'analysis'), {
      stage: 'analysis',
      errorType: 'DspyAnalysisError',
      errorCode: 'DSPY_PREDICTION_FAILED',
    })

    let openaiFailure = Object.assign(new Error('Patient actions timed out.'), {
      name: 'OpenAIAnalysisRequestError',
      code: 'OPENAI_REQUEST_FAILED',
      requestName: 'base_handover_patient_actions',
    })
    assert.deepEqual(processingFailureDiagnostic(openaiFailure, 'analysis'), {
      stage: 'analysis',
      errorType: 'OpenAIAnalysisRequestError',
      errorCode: 'OPENAI_REQUEST_FAILED',
      requestName: 'base_handover_patient_actions',
    })
  })
})
