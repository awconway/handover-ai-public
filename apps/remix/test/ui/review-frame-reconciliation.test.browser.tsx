import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { Frame } from 'remix/component'
import { renderToString } from 'remix/component/server'
import { render } from 'remix/component/test'

import { ChecklistEditor } from '../../app/assets/checklist-editor.tsx'
import { NoiseMetric } from '../../app/assets/noise-metric.tsx'
import { PatientActionsPanel } from '../../app/assets/patient-actions-panel.tsx'
import { ProcessingTimeline } from '../../app/assets/processing-timeline.tsx'
import { RichTextEditor } from '../../app/assets/rich-text-editor.tsx'
import { reviewHref, routes } from '../../app/routes.ts'
import { HandoverReviewPage } from '../../app/ui/handover-review-page.tsx'
import { normalizeReviewAnalysis, normalizeTranscriptionMetadata } from '../../app/utils/handover-review.ts'

const handoverId = 'frame-reconciliation'
const reviewTabs = [
  'details',
  'checklist',
  'summary',
  'uncertainty',
  'tasks',
  'communication',
  'transcript',
] as const
type ReviewTabKey = typeof reviewTabs[number]

const hrefs = Object.fromEntries(reviewTabs.map((reviewTab) => [
  reviewTab,
  reviewHref({ handoverId, reviewTab }),
])) as Record<ReviewTabKey, string>
const tabs = reviewTabs.map((key) => ({
  key,
  label: key === 'summary' ? 'SBAR summary' : key[0]!.toUpperCase() + key.slice(1),
  href: hrefs[key],
}))

const summarySentinels = {
  situation: 'Frame sentinel situation is stable on room air.',
  background: 'Frame sentinel background includes pneumonia.',
  assessment: 'Frame sentinel assessment is improving.',
  recommendation: 'Frame sentinel recommendation is review before discharge.',
}
const analysis = normalizeReviewAnalysis({
  checklistFocus: [{
    id: 'identity',
    label: 'id_check',
    status: 'addressed',
    note: 'Frame sentinel identity is confirmed.',
  }],
  structuredSummary: summarySentinels,
  structuredSummaryMeta: {
    reviewed: false,
    llmDraft: summarySentinels,
    edits: [],
  },
  patients: [{
    patientKey: 'frame-patient',
    displayName: 'Frame Patient',
    location: 'Bed 7',
    uncertainties: [{
      id: 'frame-uncertainty',
      statement: 'Frame sentinel oxygen target is uncertain.',
      confidence: 'medium',
      verificationNeed: 'Frame sentinel verification needs the medication chart.',
    }],
  }],
  communicationRisks: [{
    id: 'frame-risk',
    type: 'ambiguity',
    severity: 'medium',
    evidence: 'Frame sentinel communication evidence.',
    mitigation: 'Frame sentinel communication mitigation.',
  }],
  interruptionAssessment: {
    status: 'possible',
    summary: 'Frame sentinel interruption summary.',
    evidence: ['Frame sentinel interruption evidence.'],
    recommendation: 'Frame sentinel interruption recommendation.',
  },
  feedback: {
    whatWorked: [],
    needsAttention: [],
    repeatedInformation: [],
    coachingTips: [],
    durationComment: '',
  },
})
const transcriptionMetadata = normalizeTranscriptionMetadata({
  interruptionSignals: [],
  noiseSignals: [],
  segments: [{
    id: 'frame-segment',
    startMs: 4_000,
    text: 'Frame sentinel transcript line about the oxygen target.',
    speaker: 'giver',
  }],
  audioNoise: {
    available: true,
    maskedSpeechRatio: 0.23,
    severeLowMarginSpeechRatio: 0.11,
    burstsNearSpeech: 3,
    sustainedNoiseRatio: 0.17,
    averageSpeechSnrDb: 8.4,
    backgroundNoiseConcern: null,
  },
})
const tasks = [{
  id: 'frame-task',
  label: 'Frame sentinel review oxygen target.',
  completed: false,
  patientKey: 'frame-patient',
}]

function reviewPage(activeTab: ReviewTabKey) {
  return <HandoverReviewPage
    handover={{
      id: handoverId,
      title: 'Frame reconciliation handover',
      href: hrefs.details,
      status: 'completed',
      updatedAt: '2026-07-18T00:00:00.000Z',
    }}
    tabs={tabs}
    activeTab={activeTab}
    analysis={analysis}
    transcriptionMetadata={transcriptionMetadata}
    transcript="Frame sentinel raw transcript fallback."
    tasks={tasks}
    checklistAction={routes.actions.updateChecklist.href({ handoverId })}
    summaryAction={routes.actions.updateSummary.href({ handoverId })}
    patientKey="frame-patient"
    patientDisplayName="Frame Patient"
    patientLocation="Bed 7"
    viewerPerspective="delivering"
    csrfToken="csrf"
  />
}

function hydrationMarkersWithin(element: Element) {
  let walker = document.createTreeWalker(element, NodeFilter.SHOW_COMMENT)
  let starts: Comment[] = []
  let ends: Comment[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let comment = node as Comment
    if (/^\s*rmx:h:/.test(comment.data)) starts.push(comment)
    if (/^\s*\/rmx:h\s*$/.test(comment.data)) ends.push(comment)
  }
  return { starts, ends }
}

describe('handover review Frame reconciliation', () => {
  it('keeps every review panel intact across hydrated forward and reverse tab navigation', async () => {
    let responses = new Map<string, string>()
    for (let reviewTab of reviewTabs) {
      responses.set(hrefs[reviewTab], await renderToString(reviewPage(reviewTab)))
    }

    let result = render(
      <Frame name="review-workspace" src={hrefs.details} fallback={<p>Loading review</p>} />,
      {
        frameInit: {
          resolveFrame(src) {
            let response = responses.get(src)
            if (!response) throw new Error(`Unexpected review Frame source: ${src}`)
            return response
          },
          loadModule(_moduleUrl, exportName) {
            if (exportName === 'ChecklistEditor') return ChecklistEditor
            if (exportName === 'NoiseMetric') return NoiseMetric
            if (exportName === 'PatientActionsPanel') return PatientActionsPanel
            if (exportName === 'ProcessingTimeline') return ProcessingTimeline
            if (exportName === 'RichTextEditor') return RichTextEditor
            throw new Error(`Unexpected review client entry: ${exportName}`)
          },
        },
      },
    )

    async function renderFrame(reviewTab: ReviewTabKey) {
      let src = hrefs[reviewTab]
      let selector = `[data-testid="review-tab-${reviewTab}"][aria-current="page"]`
      result.root.render(<Frame name="review-workspace" src={src} fallback={<p>Loading review</p>} />)
      result.root.flush()

      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        result.root.flush()
        if (result.$(selector)) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          result.root.flush()
          return
        }
      }

      assert.fail(`Review Frame did not settle at ${src}`)
    }

    function assertDetails() {
      assert.match(result.container.textContent ?? '', /Environmental noise/)
      let maskedSpeechTrigger = result.$('button[aria-label="About Masked speech"]')
      assert.ok(maskedSpeechTrigger)
      assert.match(maskedSpeechTrigger?.parentElement?.parentElement?.textContent ?? '', /Masked speech/)
      assert.match(maskedSpeechTrigger?.parentElement?.parentElement?.textContent ?? '', /23%/)
      let noiseBoundary = result.$('[data-review-client-boundary="noise-metrics"]')
      assert.ok(noiseBoundary)
      let markers = hydrationMarkersWithin(noiseBoundary)
      assert.equal(markers.starts.length, 5)
      assert.equal(markers.ends.length, 5)
    }

    function assertChecklist() {
      assert.match(result.container.textContent ?? '', /Frame sentinel identity is confirmed\./)
      let checklistBoundary = result.$('[data-review-client-boundary="checklist"]')
      assert.ok(checklistBoundary)
      assert.ok(checklistBoundary.firstChild instanceof Comment)
      assert.match(checklistBoundary.firstChild.data, /^\s*rmx:h:/)
      assert.ok(checklistBoundary.lastChild instanceof Comment)
      assert.match(checklistBoundary.lastChild.data, /^\s*\/rmx:h\s*$/)
    }

    function assertSummary() {
      assert.ok(result.$('[data-review-panel="summary"]'))
      for (let [section, sentinel] of Object.entries(summarySentinels)) {
        let content = result.$(`[data-summary-server-content="${section}"]`)
        assert.ok(content)
        assert.match(content.textContent ?? '', new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      }
      assert.equal(result.container.querySelectorAll('[data-summary-server-content]').length, 4)
    }

    function assertPanel(reviewTab: ReviewTabKey) {
      if (reviewTab === 'details') return assertDetails()
      if (reviewTab === 'checklist') return assertChecklist()
      if (reviewTab === 'summary') return assertSummary()
      if (reviewTab === 'uncertainty') {
        assert.match(result.container.textContent ?? '', /Frame sentinel oxygen target is uncertain\./)
        return
      }
      if (reviewTab === 'tasks') {
        assert.match(result.container.textContent ?? '', /Frame sentinel review oxygen target\./)
        return
      }
      if (reviewTab === 'communication') {
        assert.match(result.container.textContent ?? '', /Frame sentinel communication evidence\./)
        return
      }
      assert.match(result.container.textContent ?? '', /Frame sentinel transcript line about the oxygen target\./)
    }

    try {
      for (let from of reviewTabs) {
        for (let to of reviewTabs) {
          await renderFrame(from)
          assertPanel(from)
          await renderFrame(to)
          assertPanel(to)
        }
      }
    } finally {
      result.cleanup()
    }
  })
})
