import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import {
  normalizeReviewAnalysis,
  normalizeTranscriptionMetadata,
  participantNames,
} from '../../app/utils/handover-review.ts'

describe('handover review model', () => {
  it('maps the persisted analysis contract into the native review surface', () => {
    let analysis = normalizeReviewAnalysis({
      headline: 'Chris needs an oxygen review',
      structuredSummary: {
        situation: 'Increasing oxygen requirement',
        background: 'COPD',
        assessment: 'Likely infective exacerbation',
        recommendation: 'Review gases at 16:00',
      },
      structuredSummaryMeta: {
        reviewed: true,
        edits: [{ section: 'assessment', previousValue: 'Infective exacerbation', nextValue: 'Likely infective exacerbation', at: '2026-07-13T01:00:00.000Z', byUserId: 'u1' }],
        llmDraft: {
          situation: 'Increasing oxygen requirement',
          background: 'COPD',
          assessment: 'Infective exacerbation',
          recommendation: 'Review gases',
        },
      },
      checklistFocus: [
        { id: 'c1', label: 'id_check', status: 'missing', note: 'Identity not confirmed.' },
        { id: 'c2', label: 'assess_obs', status: 'addressed', note: 'Observations covered.' },
      ],
      patients: [{
        patientKey: 'chris',
        displayName: 'Chris Stevens',
        location: '',
        lastConfirmedPoint: 'The oxygen target still needs confirmation.',
        restartPrompt: 'Restart by confirming the oxygen target.',
        tasks: [{ id: 't1', title: 'Confirm oxygen target', dueLabel: 'Today', dueAt: '2026-07-14T05:30:00.000Z', priority: 'high', status: 'open', reminderEnabled: true, carriedForward: false, source: 'transcript', relatedUncertaintyId: 'u1' }],
        uncertainties: [{ id: 'u1', statement: 'Oxygen target unclear', confidence: 'medium', verificationNeed: 'Confirm target', linkedTaskId: null }],
      }],
      communicationRisks: [{ id: 'r1', type: 'missing-readback', severity: 'high', evidence: 'No readback', mitigation: 'Confirm the plan' }],
      feedback: { qualityScore: 72, whatWorked: ['Clear situation'], needsAttention: [], repeatedInformation: [], coachingTips: ['Use readback'], durationComment: 'Concise' },
    })

    assert.ok(analysis)
    assert.equal(analysis.structuredSummary?.recommendation, 'Review gases at 16:00')
    assert.equal(analysis.structuredSummaryDraft?.recommendation, 'Review gases')
    assert.equal(analysis.structuredSummaryReviewed, true)
    assert.equal(analysis.structuredSummaryEdits[0]?.previousValue, 'Infective exacerbation')
    assert.equal(analysis.checklistFocus[0]?.status, 'missing')
    assert.equal(analysis.patients[0]?.uncertainties[0]?.confidence, 'medium')
    assert.equal(analysis.patients[0]?.lastConfirmedPoint, 'The oxygen target still needs confirmation.')
    assert.deepEqual(analysis.patients[0]?.tasks[0], {
      id: 't1',
      title: 'Confirm oxygen target',
      dueLabel: 'Today',
      dueAt: '2026-07-14T05:30:00.000Z',
      priority: 'high',
      status: 'open',
      reminderEnabled: true,
      carriedForward: false,
      source: 'transcript',
      relatedUncertaintyId: 'u1',
    })
    assert.equal(analysis.communicationRisks[0]?.mitigation, 'Confirm the plan')
  })

  it('narrows transcript metadata and participant records without trusting malformed JSON', () => {
    let metadata = normalizeTranscriptionMetadata({
      interruptionSignals: ['Door opened'],
      segments: [{ id: 's1', startMs: 12_500, text: 'The patient is in bed four.' }, { id: 2, text: null }],
      audioNoise: {
        available: true,
        maskedSpeechRatio: 0.12,
        severeLowMarginSpeechRatio: 0.03,
        backgroundNoiseConcern: { level: 'high', message: 'Some speech may be difficult to hear.' },
      },
    })
    assert.ok(metadata)
    assert.equal(metadata.segments.length, 1)
    assert.equal(metadata.audioNoise?.maskedSpeechRatio, 0.12)
    assert.equal(metadata.audioNoise?.backgroundNoiseConcern?.message, 'Some speech may be difficult to hear.')
    assert.deepEqual(participantNames([{ name: 'Avery' }, { role: 'Registrar' }, 'invalid']), ['Avery'])
    assert.equal(normalizeReviewAnalysis([]), null)
  })

  it('preserves explicitly empty SBAR draft sections for clinician-change provenance', () => {
    let analysis = normalizeReviewAnalysis({
      structuredSummary: {
        situation: 'Clinician-added situation',
        background: 'Original background',
        assessment: 'Original assessment',
        recommendation: 'Original recommendation',
      },
      structuredSummaryMeta: {
        llmDraft: {
          situation: '',
          background: 'Original background',
          assessment: 'Original assessment',
          recommendation: 'Original recommendation',
        },
      },
    })

    assert.ok(analysis)
    assert.equal(analysis.structuredSummaryDraft?.situation, '')
    assert.equal(analysis.structuredSummary?.situation, 'Clinician-added situation')
  })
})
