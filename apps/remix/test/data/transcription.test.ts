import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import {
  appendTranscriptToExisting,
  createManualTranscription,
  createTranscriptionService,
  sliceTranscriptionTail,
} from '../../app/data/transcription.ts'

function localTranscription(text = '[PERSON_1]: Patient remains stable.') {
  let result = createManualTranscription(text)
  result.metadata.engine = 'omi-health/omi-med-stt-v1-mlx-q8:mlx'
  result.metadata.language = 'en_au'
  result.metadata.transcriptionElapsedMs = 150
  result.metadata.segments[0]!.confidence = null
  result.metadata.audioNoise.available = true
  result.metadata.audioNoise.analysedDurationMs = result.metadata.durationMs
  return result
}

describe('native transcription service', () => {
  it('prioritises manual text over audio and mock fixtures', async () => {
    let touchedDependency = false
    let service = createTranscriptionService({
      async transcribeAudio() { touchedDependency = true; throw new Error('unexpected transcription') },
      mockTranscript() { touchedDependency = true; throw new Error('unexpected mock') },
      env: { MOCK_TRANSCRIPTION: 'true' },
    })
    let result = await service.transcribe({
      manualTranscript: [
        '[OUTGOING_NURSE]: Patient is stable after an alarm interruption.',
        '[INCOMING_NURSE]: I must confirm the oxygen target.',
      ].join('\n'),
      audioBlobKey: 'audio-object.webm',
    })

    assert.equal(touchedDependency, false)
    assert.equal(result.metadata.engine, 'manual-entry')
    assert.equal(result.metadata.mocked, false)
    assert.equal(result.metadata.segments[0]?.speaker, 'giver')
    assert.equal(result.metadata.segments[1]?.speaker, 'receiver')
    assert.deepEqual(result.metadata.segments[0]?.flags, ['interrupt', 'noise'])
    assert.deepEqual(result.metadata.segments[1]?.flags, ['handoff-critical'])
    assert.equal(result.metadata.audioNoise.available, false)
  })

  it('uses local transcription and preserves its metadata under every privacy policy', async () => {
    for (let policy of [undefined, 'disabled', 'optional', 'required']) {
      let calls: Array<{ audioBlobKey: string; originalFilename?: string | null }> = []
      let local = localTranscription()
      let service = createTranscriptionService({
        async transcribeAudio(input) { calls.push(input); return local },
        env: { LOCAL_FIRST_PROCESSING_POLICY: policy },
      })
      let result = await service.transcribe({
        manualTranscript: '  ',
        audioBlobKey: '  audio-object  ',
        audioOriginalFilename: 'recording.m4a',
      })

      assert.deepEqual(calls, [{ audioBlobKey: 'audio-object', originalFilename: 'recording.m4a' }])
      assert.equal(result, local)
      assert.equal(result.metadata.mocked, false)
      assert.equal(result.metadata.audioNoise.available, true)
      assert.equal(result.metadata.transcriptionElapsedMs, 150)
    }
  })

  it('uses real audio ahead of an intentional mock fixture', async () => {
    let localCalls = 0
    let mockCalls = 0
    let local = localTranscription()
    let service = createTranscriptionService({
      async transcribeAudio() { localCalls += 1; return local },
      env: { MOCK_TRANSCRIPTION: 'true' },
      mockTranscript: () => { mockCalls += 1; return '[OUTGOING_NURSE]: Intentional development fixture.' },
    })

    assert.equal(await service.transcribe({ audioBlobKey: 'real.webm' }), local)
    assert.equal(localCalls, 1)
    assert.equal(mockCalls, 0)

    let mocked = await service.transcribe({})
    assert.equal(mockCalls, 1)
    assert.equal(localCalls, 1)
    assert.equal(mocked.metadata.mocked, true)
    assert.equal(mocked.metadata.engine, 'mock-transcription')
    assert.equal(mocked.transcript, '[OUTGOING_NURSE]: Intentional development fixture.')
  })

  it('enables no-audio mock fixtures only for the exact true value', async () => {
    for (let value of [undefined, 'false', 'TRUE', '1']) {
      let service = createTranscriptionService({
        async transcribeAudio() { throw new Error('unexpected transcription') },
        env: { MOCK_TRANSCRIPTION: value },
      })
      await assert.rejects(
        () => service.transcribe({ manualTranscript: '  ', audioBlobKey: '  ' }),
        /No transcript or audio recording is available/,
      )
    }
    let service = createTranscriptionService({
      async transcribeAudio() { throw new Error('unexpected transcription') },
      env: { MOCK_TRANSCRIPTION: 'true' },
    })
    let mocked = await service.transcribe({ mockContext: 'queued handover audio' })
    assert.equal(mocked.transcript, '[OUTGOING_NURSE]: Mock transcription for queued handover audio.')
    assert.equal(mocked.metadata.mocked, true)
  })

  it('propagates local transcription failures without substituting mock text', async () => {
    let failure = new Error('Local transcription is unavailable.')
    let localCalls = 0
    let service = createTranscriptionService({
      async transcribeAudio() { localCalls += 1; throw failure },
      mockTranscript() { throw new Error('unexpected mock fallback') },
      env: { MOCK_TRANSCRIPTION: 'true' },
    })

    await assert.rejects(() => service.transcribe({ audioBlobKey: 'audio.webm' }), (error: unknown) => error === failure)
    assert.equal(localCalls, 1)
  })

  it('appends locally transcribed extensions while preserving timing and noise metadata', async () => {
    let previous = localTranscription('[PERSON_1]: The patient is stable.')
    let extension = localTranscription('[PERSON_2]: I will confirm the plan.')
    extension.metadata.audioNoise.bursts = [{ startMs: 100, endMs: 200, peakDbfs: -10, severity: 'low' }]
    extension.metadata.audioNoise.burstCount = 1
    let service = createTranscriptionService({
      async transcribeAudio(input) {
        assert.deepEqual(input, { audioBlobKey: 'extension-audio', originalFilename: 'extension.wav' })
        return extension
      },
      env: {},
    })
    let result = await service.transcribeExtension({
      previousTranscript: previous.transcript,
      previousMetadata: previous.metadata,
      audioBlobKey: 'extension-audio',
      audioOriginalFilename: 'extension.wav',
    })

    assert.equal(result.transcript, `${previous.transcript}\n${extension.transcript}`)
    assert.equal(result.metadata.engine, extension.metadata.engine)
    assert.equal(result.metadata.mocked, false)
    assert.equal(result.metadata.language, extension.metadata.language)
    assert.equal(result.metadata.transcriptionElapsedMs, extension.metadata.transcriptionElapsedMs)
    assert.deepEqual(result.metadata.segments.map((segment) => segment.id), ['segment-1', 'segment-2'])
    assert.equal(result.metadata.segments[1]?.startMs, previous.metadata.durationMs)
    assert.equal(result.metadata.audioNoise.analysedDurationMs, previous.metadata.durationMs + extension.metadata.durationMs)
    assert.equal(result.metadata.audioNoise.bursts[0]?.startMs, previous.metadata.durationMs + 100)
  })

  it('appends extension transcript and offsets segment metadata instead of replacing it', async () => {
    let previous = createManualTranscription('[OUTGOING_NURSE]: Patient is stable.')
    let next = createManualTranscription('[INCOMING_NURSE]: I will confirm the plan.')
    let appended = appendTranscriptToExisting({
      previousTranscript: previous.transcript,
      previousMetadata: previous.metadata,
      nextTranscript: next.transcript,
      nextMetadata: next.metadata,
    })

    assert.equal(appended.transcript, `${previous.transcript}\n${next.transcript}`)
    assert.equal(appended.metadata.mocked, false)
    assert.deepEqual(appended.metadata.segments.map((segment) => segment.id), ['segment-1', 'segment-2'])
    assert.equal(appended.metadata.segments[1]?.startMs, previous.metadata.durationMs)
    assert.equal(appended.metadata.durationMs, previous.metadata.durationMs + next.metadata.durationMs)

    let service = createTranscriptionService({ async transcribeAudio() { throw new Error('unused') }, env: {} })
    let throughService = await service.transcribeExtension({
      previousTranscript: previous.transcript,
      previousMetadata: previous.metadata,
      manualTranscript: next.transcript,
    })
    assert.equal(throughService.transcript, appended.transcript)
    assert.deepEqual(throughService.metadata.segments, appended.metadata.segments)

    let tail = sliceTranscriptionTail(appended, next.metadata.segments.length)
    assert.equal(tail.transcript, next.transcript)
    assert.equal(tail.metadata.segments[0]?.startMs, 0)
    assert.equal(tail.metadata.durationMs, next.metadata.durationMs)
    assert.equal(tail.metadata.audioNoise.available, false)
    assert.throws(() => sliceTranscriptionTail(appended, 0), /positive integer/)
  })

  it('recovers only the durable retrySegmentCount tail for an analysis-only extension retry', () => {
    let previous = createManualTranscription([
      '[OUTGOING_NURSE]: Earlier segment one.',
      '[OUTGOING_NURSE]: Earlier segment two.',
    ].join('\n'))
    let extension = createManualTranscription([
      '[INCOMING_NURSE]: New segment one.',
      '[INCOMING_NURSE]: New segment two.',
    ].join('\n'))
    let combined = appendTranscriptToExisting({
      previousTranscript: previous.transcript,
      previousMetadata: previous.metadata,
      nextTranscript: extension.transcript,
      nextMetadata: extension.metadata,
    })

    let retrySegmentCount = extension.metadata.segments.length
    let retry = sliceTranscriptionTail(combined, retrySegmentCount)

    assert.equal(retry.transcript, extension.transcript)
    assert.equal(retry.metadata.segments.length, retrySegmentCount)
    assert.deepEqual(retry.metadata.segments.map((segment) => segment.id), ['segment-1', 'segment-2'])
    assert.equal(retry.metadata.segments[0]?.startMs, 0)
    assert.doesNotMatch(retry.transcript, /Earlier segment/)
    assert.equal(retry.metadata.audioNoise.available, false)
  })

})
