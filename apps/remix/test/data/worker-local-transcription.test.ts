import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import {
  createEmptyAudioNoiseMetrics,
  createManualTranscription,
  createTranscriptionService,
} from '../../app/data/transcription.ts'
import type { HandoverJobPayload, HandoverJobRow } from '../../app/data/schema.ts'
import { processingModeForJob, providerForTranscription, transcribeForJob } from '../../worker.ts'

function handover(): Parameters<typeof transcribeForJob>[0] {
  return {
    id: 'handover-1', title: 'Handover', direction: 'outgoing',
    sourceDepartment: 'Ward', destinationDepartment: 'Ward', contextType: 'patient-handover',
    linkedPatientKey: null, linkedPatientDisplayName: null, linkedPatientLocation: null,
    participants: [], participantsEdited: false, notes: '', audioBlobKey: 'source.webm',
    transcript: '', transcriptionMetadata: null, rawTranscriptionMetadata: null,
    version: 1, privacyModeFloor: 'cloud',
  }
}

function job(payload: HandoverJobPayload, kind: HandoverJobRow['kind'] = 'create'): HandoverJobRow {
  let now = new Date('2026-10-19T00:00:00Z')
  return {
    id: 'job-1', handover_id: 'handover-1', revision: 1, kind, status: 'running', attempts: 1,
    locked_by: 'worker-1', locked_until: null, payload, created_at: now, updated_at: now,
    started_at: now, completed_at: null, failed_at: null, error_message: null,
  }
}

function fixture(mocked = false) {
  let local = createManualTranscription('[PERSON_1]: I will confirm the care plan.')
  local.metadata.engine = 'omi-health/omi-med-stt-v1-mlx-q8:mlx'
  local.metadata.transcriptionElapsedMs = 120
  let audioCalls: Array<{ audioBlobKey: string; originalFilename?: string | null }> = []
  let noiseCalls: Array<string | null | undefined> = []
  let noise = {
    ...createEmptyAudioNoiseMetrics(),
    available: true,
    analysedDurationMs: local.metadata.durationMs,
    burstCount: 1,
    bursts: [{ startMs: 100, endMs: 200, peakDbfs: -10, severity: 'low' as const }],
  }
  let services: Parameters<typeof transcribeForJob>[2] = {
    transcription: createTranscriptionService({
      env: { MOCK_TRANSCRIPTION: String(mocked) },
      async transcribeAudio(input) { audioCalls.push(input); return local },
    }),
    audioNoise: { async analyze(key) { noiseCalls.push(key); return noise } },
  }
  return { local, audioCalls, noiseCalls, noise, services }
}

async function withEnvironment(mocked: boolean, operation: () => Promise<void>) {
  let previousMock = process.env.MOCK_TRANSCRIPTION
  let previousStorage = process.env.AUDIO_STORAGE_BACKEND
  process.env.MOCK_TRANSCRIPTION = String(mocked)
  process.env.AUDIO_STORAGE_BACKEND = 'filesystem'
  try {
    await operation()
  } finally {
    if (previousMock == null) delete process.env.MOCK_TRANSCRIPTION
    else process.env.MOCK_TRANSCRIPTION = previousMock
    if (previousStorage == null) delete process.env.AUDIO_STORAGE_BACKEND
    else process.env.AUDIO_STORAGE_BACKEND = previousStorage
  }
}

describe('worker local transcription', () => {
  it('transcribes recorded audio locally across privacy modes and legacy jobs, including with mocks enabled', async () => {
    for (let mocked of [false, true]) await withEnvironment(mocked, async () => {
      for (let privacyMode of ['cloud', 'local-first', undefined] as const) {
        let f = fixture(mocked)
        let current = handover()
        let pending = job({
          ...(privacyMode ? { privacyMode } : {}),
          audioBlobKey: ' queued-recording ', audioOriginalFilename: ' recording.m4a ',
        })
        let result = await transcribeForJob(current, pending, f.services, processingModeForJob(pending.payload, {}))

        assert.deepEqual(f.audioCalls, [{ audioBlobKey: 'queued-recording', originalFilename: 'recording.m4a' }])
        assert.deepEqual(f.noiseCalls, ['queued-recording'])
        assert.equal(providerForTranscription(pending, current.audioBlobKey), 'omi-medical-edge-1')
        assert.equal(result.processedAudioBlobKey, 'queued-recording')
        assert.equal(result.result.transcript, f.local.transcript)
        assert.equal(result.result.metadata.engine, f.local.metadata.engine)
        assert.equal(result.result.metadata.mocked, false)
        assert.equal(result.result.metadata.transcriptionElapsedMs, 120)
        assert.deepEqual(result.result.metadata.audioNoise, f.noise)
      }
    })
  })

  it('uses stored source audio for create jobs but never reuses it as an extension', async () => {
    await withEnvironment(false, async () => {
      for (let mode of ['cloud', 'local-first'] as const) {
        let f = fixture()
        let current = handover()
        let result = await transcribeForJob(current, job({}), f.services, mode)
        assert.equal(result.processedAudioBlobKey, 'source.webm')
        assert.deepEqual(f.audioCalls, [{ audioBlobKey: 'source.webm', originalFilename: null }])
        assert.equal(providerForTranscription(job({}), current.audioBlobKey), 'omi-medical-edge-1')

        await assert.rejects(
          () => transcribeForJob(current, job({}, 'extend'), f.services, mode),
          /No transcript or audio recording is available/,
        )
        assert.equal(f.audioCalls.length, 1)
        assert.deepEqual(f.noiseCalls, ['source.webm'])
      }
    })
  })

  it('bypasses transcription and noise analysis for manual text even when audio and mocks are present', async () => {
    await withEnvironment(true, async () => {
      for (let mode of ['cloud', 'local-first'] as const) {
        let f = fixture(true)
        let current = handover()
        let pending = job({ manualTranscript: ' Clinician entered text. ', audioBlobKey: 'unused.webm' })
        let result = await transcribeForJob(current, pending, f.services, mode)

        assert.deepEqual(f.audioCalls, [])
        assert.deepEqual(f.noiseCalls, [])
        assert.equal(providerForTranscription(pending, current.audioBlobKey), 'manual-entry')
        assert.equal(result.processedAudioBlobKey, null)
        assert.equal(result.result.transcript, 'Clinician entered text.')
        assert.equal(result.result.metadata.engine, 'manual-entry')
        assert.equal(result.result.metadata.mocked, false)
        assert.equal(result.result.metadata.audioNoise.available, false)
      }
    })
  })

  it('merges a locally transcribed extension while giving analysis only the new tail', async () => {
    await withEnvironment(false, async () => {
      for (let mode of ['cloud', 'local-first'] as const) {
        let f = fixture()
        let prior = createManualTranscription('[OUTGOING_NURSE]: The patient remains stable.')
        let current = {
          ...handover(), transcript: prior.transcript,
          transcriptionMetadata: prior.metadata, rawTranscriptionMetadata: prior.metadata,
        }
        let pending = job({ audioBlobKey: 'extension-audio', audioOriginalFilename: 'extension.wav' }, 'extend')
        let result = await transcribeForJob(current, pending, f.services, mode)

        assert.deepEqual(f.audioCalls, [{ audioBlobKey: 'extension-audio', originalFilename: 'extension.wav' }])
        assert.deepEqual(f.noiseCalls, ['extension-audio'])
        assert.equal(result.processedAudioBlobKey, 'extension-audio')
        assert.equal(result.result.transcript, `${prior.transcript}\n${f.local.transcript}`)
        assert.equal(result.analysisInput.transcript, f.local.transcript)
        assert.equal(result.newSegmentCount, f.local.metadata.segments.length)
        assert.equal(result.result.metadata.segments[1]?.startMs, prior.metadata.durationMs)
        assert.equal(result.analysisInput.metadata.segments[0]?.startMs, 0)
        assert.equal(result.result.metadata.audioNoise.bursts[0]?.startMs, prior.metadata.durationMs + 100)
        assert.deepEqual(result.analysisInput.metadata.audioNoise, f.noise)
      }
    })
  })
})
