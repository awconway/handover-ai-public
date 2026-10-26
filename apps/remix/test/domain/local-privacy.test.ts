import { Readable } from 'node:stream'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import {
  applyLocalPrivacyExceptions,
  createDeidentifiedAnalysisRequester,
  createDeidentifiedShiftPrioritisationRequester,
  createLocalPrivacyClient,
  LocalPrivacyServiceError,
  normalizeLocalPrivacyDenyTerms,
  resolveLocalPrivacyOptions,
  type LocalDeidentificationAudit,
} from '../../app/domain/local-privacy.server.ts'
import type { AnalysisRequester, StructuredAnalysisRequest } from '../../app/domain/handover-analysis.server.ts'
import type {
  LocalPrivacyAuditPrepareInput,
  LocalPrivacyAuditSink,
} from '../../app/domain/local-privacy-audit.server.ts'

function piiFinding(input: {
  originalText: string
  label: string
  replacementText: string
  start: number
  end: number
  sources?: string[]
}) {
  return {
    original_text: input.originalText,
    label: input.label,
    entity_type: input.label,
    canonical_label: input.label,
    start: input.start,
    end: input.end,
    confidence: 0.99,
    replacement_text: input.replacementText,
    action: 'mask',
    sources: input.sources ?? ['model'],
    threshold: 0.7,
  }
}

function deidentificationResponse(text: string, findings: ReturnType<typeof piiFinding>[]) {
  return {
    text,
    token: 'opaque-token',
    replacement_count: findings.length,
    pii_findings: findings,
    model: 'OpenMed/test-model',
    openmed_version: '2.2.0',
    model_revision: null,
    backend: 'mlx',
    method: 'replace',
    policy: 'strict_no_leak',
    offline: true,
    smart_merging: true,
    safety_sweep: true,
  }
}

function analysisRequest(input: string): StructuredAnalysisRequest {
  return {
    instructions: 'Return structured data.',
    input,
    schema: { parse: (value: unknown) => value } as StructuredAnalysisRequest['schema'],
    schemaName: 'base_handover_overview',
  }
}

describe('local privacy service boundary', () => {
  it('applies repeated exact exceptions only after an exact replacement round trip', () => {
    let source = 'Jane met Jane'
    let deidentification: LocalDeidentificationAudit = {
      text: '[PERSON] met [PERSON]',
      replacementCount: 2,
      piiFindings: [
        { originalText: 'Jane', label: 'NAME', entityType: 'NAME', canonicalLabel: 'PERSON', start: 0, end: 4, confidence: 0.9, replacementText: '[PERSON]', action: 'mask', sources: ['model'], threshold: 0.4 },
        { originalText: 'Jane', label: 'NAME', entityType: 'NAME', canonicalLabel: 'PERSON', start: 9, end: 13, confidence: 0.9, replacementText: '[PERSON]', action: 'mask', sources: ['model'], threshold: 0.4 },
      ],
      modelId: 'OpenMed/test', sdkVersion: 'test', modelRevision: null, backend: 'mlx',
      method: 'replace', policy: 'strict', offline: true, smartMerging: true, safetySweep: true,
    }
    let result = applyLocalPrivacyExceptions(source, deidentification, [{
      exceptionId: 'exception-1', normalizedText: 'Jane', canonicalLabel: 'PERSON',
    }])
    assert.equal(result.text, source)
    assert.deepEqual(result.appliedExceptions, [
      { exceptionId: 'exception-1', findingOrdinal: 0 },
      { exceptionId: 'exception-1', findingOrdinal: 1 },
    ])

    assert.equal(applyLocalPrivacyExceptions(source, deidentification, [{
      exceptionId: 'case-mismatch', normalizedText: 'jane', canonicalLabel: 'PERSON',
    }]).text, deidentification.text)
    assert.equal(applyLocalPrivacyExceptions(source, deidentification, [{
      exceptionId: 'space-mismatch', normalizedText: 'Jane ', canonicalLabel: 'PERSON',
    }]).text, deidentification.text)
  })

  it('matches NFKC-equivalent text without case or whitespace folding', () => {
    let source = 'Patient Å.'
    let deidentification: LocalDeidentificationAudit = {
      text: 'Patient [NAME].', replacementCount: 1,
      piiFindings: [{ originalText: 'Å', label: 'NAME', entityType: 'NAME', canonicalLabel: 'PERSON', start: 8, end: 9, confidence: 0.9, replacementText: '[NAME]', action: 'mask', sources: ['model'], threshold: 0.4 }],
      modelId: 'OpenMed/test', sdkVersion: 'test', modelRevision: null, backend: 'mlx',
      method: 'replace', policy: 'strict', offline: true, smartMerging: true, safetySweep: true,
    }
    assert.equal(applyLocalPrivacyExceptions(source, deidentification, [{
      exceptionId: 'exception-1', normalizedText: 'Å', canonicalLabel: 'PERSON',
    }]).text, source)
  })

  it('fails closed on natural replacement collisions and overlapping findings', () => {
    let common = {
      modelId: 'OpenMed/test', sdkVersion: 'test', modelRevision: null, backend: 'mlx',
      method: 'replace', policy: 'strict', offline: true, smartMerging: true, safetySweep: true,
    } as const
    assert.throws(() => applyLocalPrivacyExceptions('Literal [P] then Jane', {
      ...common, text: 'Literal [P] then [P]', replacementCount: 1,
      piiFindings: [{ originalText: 'Jane', label: 'NAME', entityType: 'NAME', canonicalLabel: 'PERSON', start: 17, end: 21, confidence: 0.9, replacementText: '[P]', action: 'mask', sources: ['model'], threshold: 0.4 }],
    }, [{ exceptionId: 'exception-1', normalizedText: 'Jane', canonicalLabel: 'PERSON' }]), /could not be applied safely/)

    assert.throws(() => applyLocalPrivacyExceptions('Julie Smith', {
      ...common, text: '[FULL][FIRST]', replacementCount: 2,
      piiFindings: [
        { originalText: 'Julie Smith', label: 'NAME', entityType: 'NAME', canonicalLabel: 'PERSON', start: 0, end: 11, confidence: 0.9, replacementText: '[FULL]', action: 'mask', sources: ['model'], threshold: 0.4 },
        { originalText: 'Julie', label: 'FIRST_NAME', entityType: 'NAME', canonicalLabel: 'FIRST_NAME', start: 0, end: 5, confidence: 0.9, replacementText: '[FIRST]', action: 'mask', sources: ['model'], threshold: 0.4 },
      ],
    }, [
      { exceptionId: 'exception-1', normalizedText: 'Julie Smith', canonicalLabel: 'PERSON' },
      { exceptionId: 'exception-2', normalizedText: 'Julie', canonicalLabel: 'FIRST_NAME' },
    ]), /could not be applied safely/)
  })

  it('keeps an over-limit future model finding masked instead of blocking analysis', () => {
    let originalText = 'A'.repeat(513)
    let result = applyLocalPrivacyExceptions(originalText, {
      text: '[LONG FINDING]',
      piiFindings: [{
        originalText,
        replacementText: '[LONG FINDING]',
        canonicalLabel: 'ADDRESS',
        start: 0,
        end: originalText.length,
      }],
    }, [{
      exceptionId: 'exception-1',
      normalizedText: 'Jane',
      canonicalLabel: 'PERSON',
    }])

    assert.equal(result.text, '[LONG FINDING]')
    assert.deepEqual(result.appliedExceptions, [])
  })

  it('uses the full OpenMed-masked text and records no applied exception for a future incompatible map', async () => {
    let cloudCalls = 0
    let cloudInput = ''
    let preparedInput: LocalPrivacyAuditPrepareInput | undefined
    let localPrivacy = {
      async withDeidentifiedText<T>(
        _source: string,
        operation: (safeText: string, audit: LocalDeidentificationAudit) => Promise<T>,
      ): Promise<T> {
        return operation('Natural [P] then [P]', {
          text: 'Natural [P] then [P]', replacementCount: 1,
          piiFindings: [{ originalText: 'Jane', label: 'NAME', entityType: 'NAME', canonicalLabel: 'PERSON', start: 17, end: 21, confidence: 0.9, replacementText: '[P]', action: 'mask', sources: ['model'], threshold: 0.4 }],
          modelId: 'OpenMed/test', sdkVersion: 'test', modelRevision: null, backend: 'mlx',
          method: 'replace', policy: 'strict', offline: true, smartMerging: true, safetySweep: true,
        })
      },
    }
    let audit: LocalPrivacyAuditSink = {
      async prepare(input) {
        preparedInput = input
        return { auditId: 'audit-fallback', requests: [{ id: 'request-fallback', targetName: input.requests[0]!.targetName }] }
      },
      async dispatch(_requestId, operation) { return operation() },
    }
    await createDeidentifiedAnalysisRequester(
      localPrivacy as never,
      { async request(request) { cloudCalls++; cloudInput = request.input; return {} } },
      {
        audit,
        allowedFindings: [{ exceptionId: 'exception-1', normalizedText: 'Jane', canonicalLabel: 'PERSON' }],
      },
    ).request(analysisRequest('Natural [P] then Jane'))
    assert.equal(cloudCalls, 1)
    assert.equal(cloudInput, 'Natural [P] then [P]')
    assert.equal(preparedInput?.deidentification.text, 'Natural [P] then [P]')
    assert.deepEqual(preparedInput?.appliedExceptions, [])
  })

  it('deduplicates exact deny terms and supports a full 5,000-patient board', () => {
    assert.deepEqual(normalizeLocalPrivacyDenyTerms([
      { term: '  patient-key-1 ', label: ' ID_NUM ' },
      { term: 'patient-key-1', label: 'PERSON' },
    ]), [{ term: 'patient-key-1', label: 'ID_NUM' }])
    let fullBoard = normalizeLocalPrivacyDenyTerms(Array.from({ length: 10_000 }, (_, index) => ({
      term: `patient-identity-${index}`,
      label: index % 2 ? 'PERSON' : 'ID_NUM',
    })))
    assert.equal(fullBoard.length, 10_000)
    assert.throws(
      () => normalizeLocalPrivacyDenyTerms(Array.from({ length: 10_001 }, (_, index) => ({
        term: `patient-key-${index}`,
        label: 'ID_NUM',
      }))),
      /exceed the request limit/,
    )
  })

  it('defaults to loopback and refuses plaintext remote endpoints', () => {
    assert.deepEqual(resolveLocalPrivacyOptions({}), {
      baseUrl: 'http://127.0.0.1:8789',
      sharedSecret: '',
      timeoutMs: 1_260_000,
    })
    assert.throws(
      () => resolveLocalPrivacyOptions({ LOCAL_PRIVACY_API_URL: 'http://privacy.internal:8010' }),
      /must use HTTPS/,
    )
    assert.equal(
      resolveLocalPrivacyOptions({
        LOCAL_PRIVACY_API_URL: 'https://privacy.internal/api/',
        LOCAL_PRIVACY_SHARED_SECRET: 'test-secret',
      }).baseUrl,
      'https://privacy.internal/api',
    )
    assert.throws(
      () => resolveLocalPrivacyOptions({ LOCAL_PRIVACY_API_URL: 'https://privacy.internal/api/' }),
      /requires LOCAL_PRIVACY_SHARED_SECRET/,
    )
  })

  it('streams audio only to the configured local service and returns Omi metadata', async () => {
    let requestedUrl = ''
    let requestedHeaders = new Headers()
    let redirectMode: RequestRedirect | undefined
    let client = createLocalPrivacyClient({
      storage: { async getStream() { return Readable.from([Buffer.from('audio-bytes')]) } },
      env: {
        LOCAL_PRIVACY_API_URL: 'http://127.0.0.1:9001',
        LOCAL_PRIVACY_SHARED_SECRET: 'test-secret',
      },
      fetch: (async (url, init) => {
        requestedUrl = String(url)
        requestedHeaders = new Headers(init?.headers)
        redirectMode = init?.redirect
        return Response.json({
          text: 'Patient Jane Doe is in bed 4.',
          language: 'en',
          duration_ms: 3_500,
          model: 'omi-health/omi-med-stt-v1-mlx-q8',
          backend: 'mlx',
          transcription_elapsed_ms: 87,
        })
      }) as typeof fetch,
    })

    let result = await client.transcribeAudio({
      audioBlobKey: 'opaque-storage-key.bin',
      originalFilename: 'Jane Doe handover.WEBM',
    })

    assert.equal(requestedUrl, 'http://127.0.0.1:9001/v1/transcriptions')
    assert.equal(requestedHeaders.get('x-local-privacy-token'), 'test-secret')
    assert.equal(redirectMode, 'error')
    assert.equal(requestedHeaders.get('x-audio-suffix'), '.webm')
    assert.equal(result.transcript, 'Patient Jane Doe is in bed 4.')
    assert.equal(result.metadata.engine, 'omi-health/omi-med-stt-v1-mlx-q8:mlx')
    assert.equal(result.metadata.durationMs, 3_500)
    assert.equal(result.metadata.transcriptionElapsedMs, 87)
    assert.equal(result.metadata.segments[0]?.confidence, null)
    assert.equal(result.metadata.segments[0]?.speaker, 'unknown')
  })

  it('preserves an authenticated HTTPS proxy base path', async () => {
    let requestedUrl = ''
    let client = createLocalPrivacyClient({
      storage: { async getStream() { throw new Error('audio not expected') } },
      env: {
        LOCAL_PRIVACY_API_URL: 'https://privacy.internal/private-api',
        LOCAL_PRIVACY_SHARED_SECRET: 'test-secret',
      },
      fetch: (async (url) => {
        requestedUrl = String(url)
        return Response.json(deidentificationResponse('[PERSON_1]', [
          piiFinding({ originalText: 'Jane Doe', label: 'PERSON', replacementText: '[PERSON_1]', start: 0, end: 8 }),
        ]))
      }) as typeof fetch,
    })

    await client.deidentify('Jane Doe')
    assert.equal(requestedUrl, 'https://privacy.internal/private-api/v1/deidentifications')
  })

  it('combines canonical identity deny terms with existing terms and restores patient keys locally', async () => {
    let deidentificationBody: unknown
    let cloudInput = ''
    let client = createLocalPrivacyClient({
      storage: { async getStream() { throw new Error('audio not expected') } },
      env: { LOCAL_PRIVACY_API_URL: 'http://127.0.0.1:9001' },
      fetch: (async (url, init) => {
        let pathname = new URL(String(url)).pathname
        let body = init?.body ? JSON.parse(String(init.body)) as any : null
        if (pathname === '/v1/deidentifications') {
          deidentificationBody = body
          return Response.json(deidentificationResponse(
            '{"patientKey":"[ID_NUM]","displayName":"[PERSON]"}',
            [
              piiFinding({
                originalText: '587322',
                label: 'ID_NUM',
                replacementText: '[ID_NUM]',
                start: 15,
                end: 21,
                sources: ['custom:deny'],
              }),
              piiFinding({
                originalText: 'Bill Lawrence',
                label: 'PERSON',
                replacementText: '[PERSON]',
                start: 38,
                end: 51,
                sources: ['custom:deny'],
              }),
            ],
          ))
        }
        if (pathname === '/v1/reidentifications') {
          assert.deepEqual(body.value, { patientKey: '[ID_NUM]' })
          return Response.json({ value: { patientKey: '587322' } })
        }
        throw new Error(`Unexpected local path ${pathname}`)
      }) as typeof fetch,
    })
    let requester = createDeidentifiedAnalysisRequester(client, {
      async request(request) {
        cloudInput = request.input
        assert.equal('privacyDenyTerms' in request, false)
        return { patientKey: '[ID_NUM]' }
      },
    }, {
      denyTerms: [
        { term: '587322', label: 'ID_NUM' },
      ],
    })

    let result = await requester.request({
      ...analysisRequest('{"patientKey":"587322","displayName":"Bill Lawrence"}'),
      privacyDenyTerms: [{ term: 'Bill Lawrence', label: 'PERSON' }],
    })

    assert.deepEqual(deidentificationBody, {
      text: '{"patientKey":"587322","displayName":"Bill Lawrence"}',
      deny_terms: [
        { term: '587322', label: 'ID_NUM' },
        { term: 'Bill Lawrence', label: 'PERSON' },
      ],
    })
    assert.doesNotMatch(cloudInput, /587322|Bill Lawrence/)
    assert.deepEqual(result, { patientKey: '587322' })
  })

  it('sends only deidentified prompt text upstream and restores the structured result locally', async () => {
    let cloudInputs: string[] = []
    let localRequests: Array<{ pathname: string; body: unknown }> = []
    let client = createLocalPrivacyClient({
      storage: { async getStream() { throw new Error('audio not expected') } },
      env: { LOCAL_PRIVACY_API_URL: 'http://127.0.0.1:9001' },
      fetch: (async (url, init) => {
        let pathname = new URL(String(url)).pathname
        let body = init?.body ? JSON.parse(String(init.body)) as unknown : null
        localRequests.push({ pathname, body })
        if (pathname === '/v1/deidentifications') {
          return Response.json(deidentificationResponse('Patient [PERSON_1] has MRN [ID_1].', [
            piiFinding({ originalText: 'Jane Doe', label: 'PERSON', replacementText: '[PERSON_1]', start: 8, end: 16 }),
            piiFinding({ originalText: '123456', label: 'ID_NUM', replacementText: '[ID_1]', start: 25, end: 31 }),
          ]))
        }
        if (pathname === '/v1/reidentifications') {
          assert.deepEqual(body, {
            token: 'opaque-token',
            value: { summary: 'Escalate care for [PERSON_1].' },
          })
          return Response.json({ value: { summary: 'Escalate care for Jane Doe.' } })
        }
        throw new Error(`Unexpected local path ${pathname}`)
      }) as typeof fetch,
    })
    let upstream: AnalysisRequester = {
      async request(request) {
        cloudInputs.push(request.input)
        assert.doesNotMatch(request.input, /Jane Doe|123456/)
        return { summary: 'Escalate care for [PERSON_1].' }
      },
    }

    let result = await createDeidentifiedAnalysisRequester(client, upstream).request(
      analysisRequest('Patient Jane Doe has MRN 123456.'),
    )

    assert.deepEqual(result, { summary: 'Escalate care for Jane Doe.' })
    assert.deepEqual(cloudInputs, ['Patient [PERSON_1] has MRN [ID_1].'])
    assert.deepEqual(localRequests.map((request) => request.pathname), [
      '/v1/deidentifications',
      '/v1/reidentifications',
    ])
  })

  it('persists the exact cloud-bound text and OpenMed findings before dispatch without exposing the token', async () => {
    let events: string[] = []
    let preparedInput: LocalPrivacyAuditPrepareInput | undefined
    let cloudRequest: StructuredAnalysisRequest | undefined
    let client = createLocalPrivacyClient({
      storage: { async getStream() { throw new Error('audio not expected') } },
      env: { LOCAL_PRIVACY_API_URL: 'http://127.0.0.1:9001' },
      fetch: (async (url, init) => {
        let pathname = new URL(String(url)).pathname
        if (pathname === '/v1/deidentifications') {
          return Response.json(deidentificationResponse('Patient [PERSON_1] is stable.', [
            piiFinding({
              originalText: 'Jane Doe',
              label: 'PERSON',
              replacementText: '[PERSON_1]',
              start: 8,
              end: 16,
            }),
          ]))
        }
        if (pathname === '/v1/reidentifications') {
          let body = JSON.parse(String(init?.body)) as { value: { summary: string } }
          return Response.json({
            value: { summary: body.value.summary.replace('[PERSON_1]', 'Jane Doe') },
          })
        }
        throw new Error(`Unexpected local path ${pathname}`)
      }) as typeof fetch,
    })
    let audit: LocalPrivacyAuditSink = {
      async prepare(input) {
        events.push('prepare')
        preparedInput = input
        assert.equal('token' in input.deidentification, false)
        return {
          auditId: 'local-audit-1',
          requests: [{ id: 'local-request-1', targetName: 'base_handover_overview' }],
        }
      },
      async dispatch(requestId, operation) {
        events.push(`dispatch:${requestId}`)
        return operation()
      },
    }
    let upstream: AnalysisRequester = {
      async request(request) {
        events.push('cloud')
        cloudRequest = request
        return { summary: 'Escalate care for [PERSON_1].' }
      },
    }

    let result = await createDeidentifiedAnalysisRequester(client, upstream, {
      audit,
      model: 'gpt-test',
    }).request(analysisRequest('Patient Jane Doe is stable.'))

    if (!preparedInput || !cloudRequest) throw new Error('Expected the audit and cloud request to run.')
    assert.deepEqual(events, ['prepare', 'dispatch:local-request-1', 'cloud'])
    assert.equal(preparedInput.sourceText, 'Patient Jane Doe is stable.')
    assert.equal(preparedInput.deidentification.text, 'Patient [PERSON_1] is stable.')
    assert.equal(preparedInput.deidentification.piiFindings[0]?.originalText, 'Jane Doe')
    assert.equal(preparedInput.requests[0]?.model, 'gpt-test')
    assert.equal(cloudRequest.input, preparedInput.deidentification.text)
    assert.doesNotMatch(
      JSON.stringify({
        instructions: cloudRequest.instructions,
        input: cloudRequest.input,
        schemaName: cloudRequest.schemaName,
      }),
      /Jane Doe|opaque-token|local-audit-1|local-request-1/,
    )
    assert.deepEqual(result, { summary: 'Escalate care for Jane Doe.' })
  })

  it('fails closed before cloud dispatch when the local audit cannot be prepared', async () => {
    let cloudTouched = false
    let mappingReleased = false
    let client = createLocalPrivacyClient({
      storage: { async getStream() { throw new Error('audio not expected') } },
      env: { LOCAL_PRIVACY_API_URL: 'http://127.0.0.1:9001' },
      fetch: (async (url) => {
        let pathname = new URL(String(url)).pathname
        if (pathname === '/v1/deidentifications') {
          return Response.json(deidentificationResponse('[PERSON_1]', [
            piiFinding({ originalText: 'Jane Doe', label: 'PERSON', replacementText: '[PERSON_1]', start: 0, end: 8 }),
          ]))
        }
        if (pathname === '/v1/deidentifications/opaque-token') {
          mappingReleased = true
          return new Response(null, { status: 204 })
        }
        throw new Error(`Unexpected local path ${pathname}`)
      }) as typeof fetch,
    })
    let audit: LocalPrivacyAuditSink = {
      async prepare() { throw new Error('audit storage unavailable') },
      async dispatch(_requestId, operation) { return operation() },
    }

    await assert.rejects(
      () => createDeidentifiedAnalysisRequester(client, {
        async request() { cloudTouched = true; return {} },
      }, { audit }).request(analysisRequest('Jane Doe')),
      /audit storage unavailable/,
    )

    assert.equal(cloudTouched, false)
    assert.equal(mappingReleased, true)
  })

  it('protects later shift prioritisation for local-first handover history', async () => {
    let cloudInput = ''
    let client: Parameters<typeof createDeidentifiedShiftPrioritisationRequester>[0] = {
      async transcribeAudio() { throw new Error('audio not expected') },
      async deidentify() { throw new Error('direct call not expected') },
      async reidentify() { throw new Error('direct call not expected') },
      async release() {},
      async withDeidentifiedText(_text, operation, options) {
        assert.deepEqual(options?.denyTerms, [
          { term: 'patient-jane-doe', label: 'ID_NUM' },
          { term: 'Jane Doe', label: 'PERSON' },
        ])
        let safeText = '{"patients":[{"patientKey":"[ID_1]","displayName":"[PERSON_1]"}]}'
        let deidentification: LocalDeidentificationAudit = {
          text: safeText,
          replacementCount: 0,
          piiFindings: [],
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
        let result = await operation(safeText, deidentification)
        assert.deepEqual(result, { patientKeys: ['[ID_1]'] })
        return { patientKeys: ['patient-jane-doe'] } as typeof result
      },
    }
    let requester = createDeidentifiedShiftPrioritisationRequester(client, async (request) => {
      cloudInput = request.input
      assert.doesNotMatch(request.input, /Jane Doe|patient-jane-doe/)
      return { patientKeys: ['[ID_1]'] }
    }, {
      denyTerms: [
        { term: 'patient-jane-doe', label: 'ID_NUM' },
        { term: 'Jane Doe', label: 'PERSON' },
      ],
    })

    let result = await requester({
      instructions: 'Order the patients.',
      input: '{"patients":[{"patientKey":"patient-jane-doe","displayName":"Jane Doe"}]}',
    })

    assert.match(cloudInput, /\[PERSON_1\]/)
    assert.deepEqual(result, { patientKeys: ['patient-jane-doe'] })
  })

  it('fails closed on an invalid deidentification response and never invokes the cloud requester', async () => {
    let cloudTouched = false
    let client = createLocalPrivacyClient({
      storage: { async getStream() { throw new Error('audio not expected') } },
      env: { LOCAL_PRIVACY_API_URL: 'http://127.0.0.1:9001' },
      fetch: (async () => Response.json({ text: 'unsafe response without a token' })) as typeof fetch,
    })
    let upstream: AnalysisRequester = {
      async request() { cloudTouched = true; return {} },
    }

    await assert.rejects(
      () => createDeidentifiedAnalysisRequester(client, upstream).request(analysisRequest('Jane Doe')),
      (error: unknown) => error instanceof LocalPrivacyServiceError && error.operation === 'deidentification',
    )
    assert.equal(cloudTouched, false)
  })

  it('releases the opaque mapping when the cloud operation fails', async () => {
    let releases = 0
    let client = createLocalPrivacyClient({
      storage: { async getStream() { throw new Error('audio not expected') } },
      env: { LOCAL_PRIVACY_API_URL: 'http://127.0.0.1:9001' },
      fetch: (async (url) => {
        let pathname = new URL(String(url)).pathname
        if (pathname === '/v1/deidentifications') {
          return Response.json(deidentificationResponse('[PERSON_1]', [
            piiFinding({ originalText: 'Jane Doe', label: 'PERSON', replacementText: '[PERSON_1]', start: 0, end: 8 }),
          ]))
        }
        if (pathname === '/v1/deidentifications/opaque-token') {
          releases += 1
          return new Response(null, { status: 204 })
        }
        throw new Error('Unexpected request')
      }) as typeof fetch,
    })

    await assert.rejects(
      () => client.withDeidentifiedText('Jane Doe', async () => { throw new Error('cloud unavailable') }),
      /cloud unavailable/,
    )
    assert.equal(releases, 1)
  })
})
