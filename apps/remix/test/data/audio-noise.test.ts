import { access, readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import {
  AUDIO_NOISE_LIMITS,
  analyzePcmSamples,
  attachAudioNoiseMetrics,
  createAudioNoiseAnalyzer,
  getBackgroundNoiseConcern,
  getBackgroundNoiseConcernReason,
  mergeAudioNoiseMetrics,
  type BackgroundNoiseConcernInput,
} from '../../app/data/audio-noise.ts'
import {
  createEmptyAudioNoiseMetrics,
  createManualTranscription,
  type AudioNoiseMetrics,
} from '../../app/data/transcription.ts'

const quietInput: BackgroundNoiseConcernInput = {
  maskedSpeechRatio: 0,
  severeLowMarginSpeechRatio: 0,
  longestLowMarginRunSeconds: 0,
  burstsNearSpeech: 0,
  sustainedNoiseRatio: 0,
}

function sineWave(seconds = 1, sampleRate = 16_000): Float32Array {
  let samples = new Float32Array(seconds * sampleRate)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin(2 * Math.PI * 440 * index / sampleRate) * 0.15
  }
  return samples
}

function availableMetrics(input: Partial<AudioNoiseMetrics> = {}): AudioNoiseMetrics {
  return {
    ...createEmptyAudioNoiseMetrics(),
    available: true,
    score: 25,
    analysedDurationMs: 1_000,
    speechDurationMs: 500,
    maskedSpeechDurationMs: 100,
    maskedSpeechRatio: 0.2,
    severeLowMarginSpeechDurationMs: 0,
    severeLowMarginSpeechRatio: 0,
    averageSpeechSnrDb: 10,
    estimatedNoiseFloorDbfs: -42,
    burstCount: 1,
    burstsNearSpeech: 1,
    sustainedNoiseDurationMs: 100,
    sustainedNoiseRatio: 0.1,
    bursts: [{ startMs: 100, endMs: 400, peakDbfs: -20, severity: 'medium' }],
    backgroundNoiseConcern: {
      level: 'some',
      action: 'review_before_submitting',
      reason: 'speech_hard_to_hear',
      message: 'Some background noise was detected.',
      showTimestamps: false,
    },
    ...input,
  }
}

describe('native stored-audio noise analysis', () => {
  it('keeps materialization and ffmpeg decoding within production caps', () => {
    assert.deepEqual(AUDIO_NOISE_LIMITS, {
      targetSampleRate: 16_000,
      maxDecodedAudioSeconds: 30 * 60,
      maxDecodedPcmBytes: 16_000 * 4 * 30 * 60,
      maxFfmpegDecodeMs: 120_000,
      maxSourceAudioBytes: 100 * 1024 * 1024,
      maxMaterializationMs: 60_000,
    })
  })

  it('materializes an opaque storage stream privately and always removes it', async () => {
    let decoderPath = ''
    let decoderOptions: Record<string, unknown> = {}
    let analyzer = createAudioNoiseAnalyzer({
      storage: {
        async getStream(key) {
          assert.equal(key, 'opaque-audio-object')
          return Readable.from([Buffer.from('stored-audio-bytes')])
        },
      },
      env: { FFMPEG_PATH: '/safe/ffmpeg' },
      decodeAudio: async (audioPath, options) => {
        decoderPath = audioPath
        decoderOptions = options
        assert.equal((await readFile(audioPath)).toString(), 'stored-audio-bytes')
        assert.doesNotMatch(audioPath, /opaque-audio-object/)
        return sineWave()
      },
    })

    let result = await analyzer.analyze('opaque-audio-object')

    assert.equal(result.available, true)
    assert.equal(result.analysedDurationMs, 1_000)
    assert.equal(decoderOptions.ffmpegPath, '/safe/ffmpeg')
    assert.equal(decoderOptions.maxDecodedPcmBytes, AUDIO_NOISE_LIMITS.maxDecodedPcmBytes)
    await assert.rejects(() => access(decoderPath), /ENOENT/)
  })

  it('returns empty metrics and cleans temporary bytes when decoding fails', async () => {
    let decoderPath = ''
    let analyzer = createAudioNoiseAnalyzer({
      storage: { async getStream() { return Readable.from([Buffer.from('not-audio')]) } },
      decodeAudio: async (audioPath) => {
        decoderPath = audioPath
        throw new Error('decoder included sensitive diagnostics')
      },
    })

    assert.deepEqual(await analyzer.analyze('stored-object'), createEmptyAudioNoiseMetrics())
    await assert.rejects(() => access(decoderPath), /ENOENT/)
  })

  it('rejects an oversized storage stream before invoking the decoder', async () => {
    let decoderCalled = false
    let analyzer = createAudioNoiseAnalyzer({
      storage: { async getStream() { return Readable.from([Buffer.from('12345')]) } },
      limits: { maxSourceAudioBytes: 4 },
      decodeAudio: async () => {
        decoderCalled = true
        return sineWave()
      },
    })

    assert.deepEqual(await analyzer.analyze('stored-object'), createEmptyAudioNoiseMetrics())
    assert.equal(decoderCalled, false)
  })

  it('does not access storage when no audio object exists', async () => {
    let touchedStorage = false
    let analyzer = createAudioNoiseAnalyzer({
      storage: {
        async getStream() {
          touchedStorage = true
          throw new Error('unexpected')
        },
      },
    })

    assert.deepEqual(await analyzer.analyze('  '), createEmptyAudioNoiseMetrics())
    assert.equal(touchedStorage, false)
  })

  it('analyses decoded mono PCM without retaining source audio', () => {
    let result = analyzePcmSamples(sineWave())
    assert.equal(result.available, true)
    assert.equal(result.analysedDurationMs, 1_000)
    assert.ok(result.score >= 0 && result.score <= 100)
  })

  it('uses component evidence to gate background-noise concern', () => {
    assert.deepEqual(getBackgroundNoiseConcern(quietInput), {
      level: 'none',
      action: 'none',
      reason: 'none',
      message: null,
      showTimestamps: false,
    })
    assert.deepEqual(getBackgroundNoiseConcern({
      ...quietInput,
      maskedSpeechRatio: 0.25,
      burstsNearSpeech: 6,
    }), {
      level: 'high',
      action: 'check_key_details',
      reason: 'mixed',
      message: 'High background noise was detected.',
      showTimestamps: false,
    })
    assert.equal(getBackgroundNoiseConcernReason({
      ...quietInput,
      severeLowMarginSpeechRatio: 0.46,
    }), 'speech_hard_to_hear')
    assert.equal(getBackgroundNoiseConcern({
      ...quietInput,
      severeLowMarginSpeechRatio: 0.46,
    }).level, 'veryHigh')
  })

  it('merges extension timing and attaches only safe derived noise signals', () => {
    let previous = availableMetrics()
    let next = availableMetrics({
      analysedDurationMs: 2_000,
      speechDurationMs: 1_000,
      maskedSpeechDurationMs: 300,
      maskedSpeechRatio: 0.3,
      sustainedNoiseDurationMs: 400,
      sustainedNoiseRatio: 0.2,
      bursts: [{ startMs: 50, endMs: 350, peakDbfs: -18, severity: 'high' }],
    })
    let merged = mergeAudioNoiseMetrics(previous, next, 1_000)
    assert.equal(merged.analysedDurationMs, 3_000)
    assert.equal(merged.bursts[1]?.startMs, 1_050)

    let metadata = createManualTranscription('Patient details require review.').metadata
    let attached = attachAudioNoiseMetrics(metadata, next)
    assert.equal(attached.audioNoise.available, true)
    assert.deepEqual(attached.noiseSignals, ['Some background noise was detected.'])
    assert.doesNotMatch(attached.noiseSignals.join(' '), /Patient details/)
  })
})
