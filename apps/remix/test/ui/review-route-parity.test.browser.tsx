import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { render } from 'remix/component/test'

import { computedStyle, resolvedColor } from './styles.ts'

import { PrivacyFindingAllowControl } from '../../app/assets/privacy-finding-allow-control.tsx'
import { HandoverReviewPage } from '../../app/ui/handover-review-page.tsx'
import { reviewHref, routes, type ReviewTab } from '../../app/routes.ts'
import {
  normalizeReviewAnalysis,
  normalizeTranscriptionMetadata,
  type ReviewTranscriptPrivacyAudit,
} from '../../app/utils/handover-review.ts'

function handoverHref(handoverId: string) {
  return routes.workspace.handover.href({ handoverId })
}

function handoverReviewHref(handoverId: string, reviewTab: ReviewTab) {
  return reviewHref({ handoverId, reviewTab })
}

function transcriptPrivacyAudit(
  findings: ReviewTranscriptPrivacyAudit['findings'],
): ReviewTranscriptPrivacyAudit {
  return {
    id: 'audit-1',
    modelId: 'OpenMed/superclinical-small',
    modelRevision: 'rev-1',
    backend: 'mlx',
    method: 'token-classification',
    policy: 'strict-no-leak',
    offline: true,
    replacementCount: findings.length,
    createdAt: '2026-08-26T01:00:00.000Z',
    rerunRequired: false,
    findings,
  }
}

describe('handover review route parity', () => {
  it('keeps partial analysis out of the header and disables preview mutations', () => {
    let analysis = normalizeReviewAnalysis({
      analysisReadiness: { checklist: true, actions: true, uncertainty: true },
      participants: [],
      checklistFocus: [{ id: 'identity', label: 'id_check', status: 'addressed', note: 'Identity confirmed.' }],
      patients: [{
        patientKey: 'arthur-dent',
        displayName: 'Arthur Dent',
        location: 'Bed 12',
        tasks: [{ id: 't1', title: 'Review oxygen target', dueLabel: 'No due date set', priority: 'routine', status: 'open' }],
        uncertainties: [{ id: 'u1', statement: 'Oxygen target unclear', confidence: 'medium', verificationNeed: 'Check the chart' }],
      }],
    })
    let result = render(<HandoverReviewPage
      handover={{ id: 'active-header', title: 'Ward handover', href: handoverHref('active-header'), status: 'analysing' }}
      tabs={[
        { key: 'details', label: 'Details', href: handoverReviewHref('active-header', 'details') },
        { key: 'checklist', label: 'Checklist', href: handoverReviewHref('active-header', 'checklist') },
        { key: 'tasks', label: 'Actions', href: handoverReviewHref('active-header', 'tasks') },
        { key: 'uncertainty', label: 'Uncertainty', href: handoverReviewHref('active-header', 'uncertainty') },
      ]}
      activeTab="checklist"
      analysis={analysis}
      interactionsDisabled
      checklistAction={routes.actions.updateChecklist.href({ handoverId: 'active-header' })}
      extendAction={routes.actions.extendHandover.href({ handoverId: 'active-header' })}
      assignmentAction={routes.actions.createAssignments.href()}
      recipients={[]}
      deleteAction={routes.actions.deleteHandover.href({ handoverId: 'active-header' })}
      inboxPlacement={{
        action: routes.actions.placeAssignment.href({ assignmentId: 'a1' }),
        assignmentTitle: 'Ward handover',
        assignedBy: 'Ford Prefect',
        sourceLabel: 'Night shift',
        shifts: [{ id: 's1', title: 'Day shift' }],
      }}
      csrfToken="csrf"
    />)

    assert.ok(result.$('[aria-label="Patient handover scope loading"]'))
    assert.ok(result.$('[aria-label="Participants loading"]'))
    assert.doesNotMatch(result.$('[data-testid="review-patient-header"]')?.textContent ?? '', /Arthur Dent/)
    assert.equal((result.$('[data-testid="checklist-toggle-identity"]') as HTMLInputElement).disabled, true)
    assert.match(result.$('[data-testid="checklist-editor"] header')?.textContent ?? '', /1 of 1 items covered/)
    assert.ok(result.$('[data-checklist-status-icon="covered"] svg[data-icon="check-check"]'))
    assert.equal((result.$('[data-testid="review-action-recommence"]') as HTMLButtonElement).disabled, false)
    assert.equal(computedStyle(result.$('[data-testid="review-actions-primary-row"] > div')).display, matchMedia('(min-width: 768px)').matches ? 'block' : 'none')
    assert.equal(result.$('[data-testid="review-tab-checklist"]')?.getAttribute('aria-describedby'), 'review-tab-checklist-metric')
    assert.equal(result.$('#review-tab-checklist-metric')?.textContent, '1 covered, 0 not covered')
    assert.equal(result.container.querySelectorAll('h1').length, 1)
    assert.match(result.$('h1')?.textContent ?? '', /Handover review · Ward handover/)
    assert.equal(result.container.querySelector('main'), null)
    assert.equal(result.$('#review-content > section')?.getAttribute('aria-labelledby'), 'handover-review-title')
    result.cleanup()
  })

  it('keeps transcript normalization, timestamps, and page-level scrolling consistent', () => {
    let transcriptMetadata = normalizeTranscriptionMetadata({
      interruptionSignals: [],
      segments: [{ id: 's1', startMs: 5_000, text: 'Confirm the oxygen   target\\nbefore transfer.', speaker: 'giver' }],
    })
    let result = render(<HandoverReviewPage
      handover={{ id: 'transcript-parity', title: 'Ward handover', href: handoverHref('transcript-parity'), status: 'completed' }}
      tabs={[{ key: 'transcript', label: 'Transcript', href: handoverReviewHref('transcript-parity', 'transcript') }]}
      activeTab="transcript"
      transcript=""
      transcriptionMetadata={transcriptMetadata}
    />)
    assert.match(result.container.textContent ?? '', /00:05/)
    let transcriptRegion = result.$('[data-testid="transcript-scroll-region"]')
    assert.match(transcriptRegion?.textContent ?? '', /target\nbefore transfer/)
    assert.equal(computedStyle(transcriptRegion).overflowY, 'visible')
    assert.equal(computedStyle(transcriptRegion).overscrollBehaviorY, 'auto')
    result.cleanup()

    let analysis = normalizeReviewAnalysis({
      patients: [{
        patientKey: 'arthur-dent',
        displayName: 'Arthur Dent',
        location: 'Bed 12',
        uncertainties: [{ id: 'u1', statement: 'oxygen target before transfer', confidence: 'medium', verificationNeed: 'Confirm the target' }],
      }],
    })
    result = render(<HandoverReviewPage
      handover={{ id: 'context-parity', title: 'Ward handover', href: handoverHref('context-parity'), status: 'completed' }}
      tabs={[{ key: 'uncertainty', label: 'Uncertainty', href: handoverReviewHref('context-parity', 'uncertainty') }]}
      activeTab="uncertainty"
      analysis={analysis}
      transcriptionMetadata={transcriptMetadata}
    />)
    assert.ok(result.$('[data-testid="uncertainty-transcript-context"]'))
    assert.equal(computedStyle(result.$('[data-testid="uncertainty-transcript-context"] mark')).color, resolvedColor('var(--color-slate-950)'))
    result.cleanup()

    result = render(<HandoverReviewPage
      handover={{ id: 'raw-transcript-parity', title: 'Ward handover', href: handoverHref('raw-transcript-parity'), status: 'completed' }}
      tabs={[{ key: 'transcript', label: 'Transcript', href: handoverReviewHref('raw-transcript-parity', 'transcript') }]}
      activeTab="transcript"
      transcript={'Line one\\nLine two'}
      transcriptionMetadata={normalizeTranscriptionMetadata({ interruptionSignals: [], segments: [] })}
    />)
    assert.match(result.$('[data-testid="transcript-scroll-region"]')?.textContent ?? '', /Line one\nLine two/)
    result.cleanup()
  })

  it('allows a merged OpenMed span without posting raw PII and then renders it as ordinary text', async () => {
    let transcript = '🩺 Julie Smith is stable.'
    let findings: ReviewTranscriptPrivacyAudit['findings'] = [
      {
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
      },
      {
        ordinal: 1,
        sourceAuditId: 'audit-1',
        sourceOrdinal: 1,
        allowedInAnalysis: false,
        label: 'GIVEN_NAME',
        entityType: 'NAME',
        canonicalLabel: 'given_name',
        startCodepoint: 2,
        endCodepoint: 7,
        confidence: 0.94,
        sources: ['model'],
      },
    ]
    let transcriptMetadata = normalizeTranscriptionMetadata({
      interruptionSignals: [],
      segments: [{ id: 's1', startMs: 5_000, text: transcript, speaker: 'giver' }],
    })
    let result = render(<HandoverReviewPage
      handover={{ id: 'pii-highlight', title: 'Ward handover', href: handoverHref('pii-highlight'), status: 'completed' }}
      tabs={[{ key: 'transcript', label: 'Transcript', href: handoverReviewHref('pii-highlight', 'transcript') }]}
      activeTab="transcript"
      transcript={transcript}
      transcriptionMetadata={transcriptMetadata}
      transcriptPrivacy={transcriptPrivacyAudit(findings)}
      transcriptPrivacyAllowAction="/actions/handovers/pii-highlight/privacy-findings/allow"
      csrfToken="csrf"
    />)

    let notice = result.$('[data-testid="transcript-privacy-notice"]')
    let highlights = result.container.querySelectorAll('[data-pii-highlight]')
    let highlightGroup = result.$('[data-pii-highlight-group]') as HTMLElement
    let allowTrigger = result.$('[data-testid="allow-privacy-finding-trigger"]') as HTMLButtonElement
    assert.match(notice?.textContent ?? '', /Personal information/)
    assert.doesNotMatch(notice?.textContent ?? '', /PII spans|superclinical-small|offline/)
    assert.doesNotMatch(notice?.textContent ?? '', /Highlighted text was tagged on this workstation/)
    assert.equal(notice?.querySelector('p'), null)
    assert.equal(highlightGroup.tagName, 'SPAN')
    assert.equal(highlightGroup.querySelector('details, summary'), null)
    assert.equal(result.container.querySelectorAll('[data-testid="allow-privacy-finding-trigger"]').length, 1)
    assert.equal(allowTrigger.tagName, 'BUTTON')
    assert.equal(allowTrigger.getAttribute('aria-label'), 'Review allowing this tagged span in analysis')
    assert.equal(allowTrigger.getAttribute('aria-haspopup'), 'dialog')
    assert.equal(allowTrigger.getAttribute('aria-expanded'), 'false')
    assert.equal(allowTrigger.getAttribute('aria-controls'), 'pii-2-13-0-allow-dialog')
    assert.ok(allowTrigger.querySelector('svg[aria-hidden="true"]'))
    assert.equal(highlights.length, 1)
    assert.equal(highlights[0]?.querySelector('[aria-hidden="true"]')?.textContent, 'Julie Smith')
    assert.equal(highlights[0]?.getAttribute('data-pii-labels'), 'Person,Given Name')
    assert.match(highlights[0]?.getAttribute('title') ?? '', /Person \(98% confidence\).*Given Name \(94% confidence\)/)
    assert.match(result.$('[data-testid="transcript-scroll-region"]')?.textContent ?? '', /🩺 Julie Smith.*Person · 98%.*Given Name · 94%.*is stable/s)
    assert.match(result.container.textContent ?? '', /00:05/)

    await result.act(() => allowTrigger.click())
    allowTrigger = result.$('[data-testid="allow-privacy-finding-trigger"]') as HTMLButtonElement
    let confirmation = result.$('[data-testid="allow-privacy-finding-confirmation"]') as HTMLElement
    assert.equal(allowTrigger.getAttribute('aria-expanded'), 'true')
    assert.equal(confirmation.matches(':popover-open'), true)
    assert.equal(confirmation.getAttribute('role'), 'dialog')
    assert.match(confirmation.textContent ?? '', /Allow in analysis\?/)
    assert.match(confirmation.textContent ?? '', /next cloud analysis.*carries forward.*recommenced/s)

    let cancel = Array.from(confirmation.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Cancel')
    assert.ok(cancel)
    assert.equal(document.activeElement, cancel)
    await result.act(() => cancel.click())
    allowTrigger = result.$('[data-testid="allow-privacy-finding-trigger"]') as HTMLButtonElement
    confirmation = result.$('[data-testid="allow-privacy-finding-confirmation"]') as HTMLElement
    assert.equal(allowTrigger.getAttribute('aria-expanded'), 'false')
    assert.equal(confirmation.matches(':popover-open'), false)
    assert.equal(document.activeElement, allowTrigger)

    await result.act(() => allowTrigger.click())
    let allowForm = result.$('[data-testid="allow-privacy-findings-form"]') as HTMLFormElement
    assert.equal(allowForm?.getAttribute('action'), '/actions/handovers/pii-highlight/privacy-findings/allow')
    let submit = allowForm?.querySelector<HTMLButtonElement>('button[type="submit"]')
    assert.equal(submit?.textContent, 'Allow')
    assert.equal(submit?.getAttribute('aria-label'), 'Confirm allowing tagged text in analysis')
    assert.equal(allowForm?.querySelector('input[name="_csrf"]')?.getAttribute('value'), 'csrf')
    assert.deepEqual(JSON.parse(allowForm?.querySelector<HTMLInputElement>('input[name="findingRefs"]')?.value ?? 'null'), [
      { auditId: 'audit-1', ordinal: 0 },
      { auditId: 'audit-1', ordinal: 1 },
    ])
    assert.doesNotMatch(allowForm?.innerHTML ?? '', /Julie Smith|PATIENT_NAME|GIVEN_NAME/)
    result.cleanup()

    result = render(<HandoverReviewPage
      handover={{ id: 'pii-highlight', title: 'Ward handover', href: handoverHref('pii-highlight'), status: 'completed' }}
      tabs={[{ key: 'transcript', label: 'Transcript', href: handoverReviewHref('pii-highlight', 'transcript') }]}
      activeTab="transcript"
      transcript={transcript}
      transcriptionMetadata={transcriptMetadata}
      transcriptPrivacy={transcriptPrivacyAudit(findings.map((finding) => ({ ...finding, allowedInAnalysis: true })))}
      transcriptPrivacyAllowAction="/actions/handovers/pii-highlight/privacy-findings/allow"
      transcriptPrivacyAnalysisStale
      rerunAnalysisAction="/actions/handovers/pii-highlight/rerun-analysis"
      csrfToken="csrf"
    />)
    notice = result.$('[data-testid="transcript-privacy-notice"]')
    let transcriptRegion = result.$('[data-testid="transcript-scroll-region"]')
    assert.equal(transcriptRegion?.querySelector('[data-pii-highlight-group]'), null)
    assert.equal(transcriptRegion?.querySelector('mark'), null)
    assert.equal(transcriptRegion?.querySelector('[data-pii-labels]'), null)
    assert.equal(transcriptRegion?.querySelector('[data-testid="allow-privacy-finding-trigger"]'), null)
    assert.match(transcriptRegion?.textContent ?? '', /🩺 Julie Smith is stable\./)
    assert.doesNotMatch(transcriptRegion?.textContent ?? '', /Person|Given Name|confidence/)
    assert.match(notice?.textContent ?? '', /^Personal informationRerun analysis$/)
    assert.equal(notice?.querySelector('p'), null)
    let rerunForm = result.$('[data-testid="rerun-analysis-form"]')
    assert.equal(rerunForm?.getAttribute('action'), '/actions/handovers/pii-highlight/rerun-analysis')
    assert.equal(rerunForm?.querySelector('button')?.textContent, 'Rerun analysis')
    assert.equal(rerunForm?.querySelector('input[name="_csrf"]')?.getAttribute('value'), 'csrf')
    assert.equal(result.container.querySelectorAll('form[data-workflow="rerun-analysis"]').length, 1)
    result.cleanup()
  })

  it('keeps the allow confirmation visible while its mutation is pending and reports failures in place', async () => {
    let originalFetch = window.fetch
    let rejectRequest: ((reason?: unknown) => void) | undefined
    window.fetch = () => new Promise<Response>((_resolve, reject) => {
      rejectRequest = reject
    })
    let result = render(<PrivacyFindingAllowControl
      action="/actions/handovers/pii-highlight/privacy-findings/allow"
      controlId="pending-allow"
      csrfToken="csrf"
      findingRefs={JSON.stringify([{ auditId: 'audit-1', ordinal: 0 }])}
    />)

    try {
      await result.act(() => (result.$('[data-testid="allow-privacy-finding-trigger"]') as HTMLButtonElement).click())
      let confirmation = result.$('[data-testid="allow-privacy-finding-confirmation"]') as HTMLElement
      let cancel = Array.from(confirmation.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Cancel')
      assert.equal(document.activeElement, cancel)

      await result.act(async () => {
        ;(result.$('button[type="submit"]') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      confirmation = result.$('[data-testid="allow-privacy-finding-confirmation"]') as HTMLElement
      assert.equal(result.$('[data-testid="allow-privacy-findings-form"]')?.getAttribute('aria-busy'), 'true')
      assert.equal(confirmation.matches(':popover-open'), true)

      await result.act(() => confirmation.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
      confirmation = result.$('[data-testid="allow-privacy-finding-confirmation"]') as HTMLElement
      assert.equal(confirmation.matches(':popover-open'), true)
      assert.equal(result.$('[data-testid="allow-privacy-finding-trigger"]')?.getAttribute('aria-expanded'), 'true')

      await result.act(async () => {
        rejectRequest?.(new Error('Network unavailable'))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      confirmation = result.$('[data-testid="allow-privacy-finding-confirmation"]') as HTMLElement
      assert.equal(confirmation.matches(':popover-open'), true)
      assert.equal(result.$('[data-testid="allow-privacy-findings-form"]')?.hasAttribute('aria-busy'), false)
      assert.match(confirmation.querySelector('[role="alert"]')?.textContent ?? '', /Network unavailable/)
    } finally {
      result.cleanup()
      window.fetch = originalFetch
    }
  })

  it('shows a completed zero-finding local check and rejects malformed span data', () => {
    let baseProps = {
      handover: { id: 'pii-empty', title: 'Ward handover', href: handoverHref('pii-empty'), status: 'completed' as const },
      tabs: [{ key: 'transcript', label: 'Transcript', href: handoverReviewHref('pii-empty', 'transcript') }],
      activeTab: 'transcript',
      transcript: 'No identifiers were detected.',
    }
    let result = render(<HandoverReviewPage {...baseProps} transcriptPrivacy={transcriptPrivacyAudit([])} />)
    let emptyNotice = result.$('[data-testid="transcript-privacy-notice"]')
    assert.equal(emptyNotice?.textContent, 'Personal information')
    assert.doesNotMatch(emptyNotice?.textContent ?? '', /0 PII spans|superclinical-small|offline/)
    assert.equal(emptyNotice?.querySelector('p'), null)
    assert.match(result.$('[data-testid="processing-step-list"]')?.textContent ?? '', /Transcribed.*Analysed/s)
    assert.equal(result.$('[data-testid="transcript-privacy-checking"]'), null)
    assert.equal(result.container.querySelector('[data-pii-highlight]'), null)
    result.cleanup()

    let invalid = transcriptPrivacyAudit([{
      ordinal: 0,
      sourceAuditId: 'audit-1',
      sourceOrdinal: 0,
      allowedInAnalysis: false,
      label: 'PATIENT_NAME',
      entityType: 'NAME',
      canonicalLabel: 'person',
      startCodepoint: 0,
      endCodepoint: 99,
      confidence: 0.9,
      sources: ['model'],
    }])
    result = render(<HandoverReviewPage {...baseProps} transcriptPrivacy={invalid} />)
    assert.equal(result.$('[data-testid="transcript-privacy-notice"]'), null)
    assert.equal(result.container.querySelector('[data-pii-highlight]'), null)
    assert.match(result.$('[data-testid="transcript-scroll-region"]')?.textContent ?? '', /No identifiers were detected/)
    result.cleanup()

    result = render(<HandoverReviewPage {...baseProps} transcriptPrivacyExpected />)
    assert.equal(result.$('[data-testid="transcript-privacy-unavailable"]'), null)
    assert.equal(result.container.querySelector('[data-pii-highlight]'), null)
    result.cleanup()
  })

  it('shows the local PII check as in progress instead of reporting a stale zero-finding result', () => {
    let result = render(<HandoverReviewPage
      handover={{ id: 'pii-checking', title: 'Ward handover', href: handoverHref('pii-checking'), status: 'analysing' }}
      tabs={[{ key: 'transcript', label: 'Transcript', href: handoverReviewHref('pii-checking', 'transcript') }]}
      activeTab="transcript"
      transcript="Julie Smith is stable."
      transcriptPrivacy={transcriptPrivacyAudit([])}
      transcriptPrivacyExpected
    />)

    let checkingNotice = result.$('[data-testid="transcript-privacy-checking"]')
    assert.match(checkingNotice?.textContent ?? '', /Checking transcript for personal information/)
    assert.doesNotMatch(checkingNotice?.textContent ?? '', /This check is running on this workstation/)
    assert.equal(checkingNotice?.querySelector('p'), null)
    assert.match(result.$('[data-testid="processing-step-list"]')?.textContent ?? '', /Transcribed.*Analysing/s)
    assert.doesNotMatch(result.container.textContent ?? '', /no PII spans were tagged/i)
    assert.equal(result.$('[data-testid="transcript-privacy-notice"]'), null)
    assert.equal(result.container.querySelector('[data-pii-highlight]'), null)
    result.cleanup()
  })

  it('uses React communication empty copy and environmental-noise warning geometry', () => {
    let analysis = normalizeReviewAnalysis({
      feedback: {
        whatWorked: [],
        needsAttention: [],
        repeatedInformation: [],
        coachingTips: [],
        durationComment: '',
      },
    })
    let result = render(<HandoverReviewPage
      handover={{ id: 'communication-parity', title: 'Ward handover', href: handoverHref('communication-parity'), status: 'completed' }}
      tabs={[{ key: 'communication', label: 'Communication', href: handoverReviewHref('communication-parity', 'communication') }]}
      activeTab="communication"
      analysis={analysis}
      viewerPerspective="delivering"
    />)
    assert.match(result.container.textContent ?? '', /No issues captured\./)
    assert.match(result.container.textContent ?? '', /No repeated issues were flagged\./)
    assert.match(result.container.textContent ?? '', /No tips captured\./)
    assert.match(result.container.textContent ?? '', /No notes captured\./)
    assert.doesNotMatch(result.container.textContent ?? '', /No timing feedback was recorded/)
    result.cleanup()

    let metadata = normalizeTranscriptionMetadata({
      audioNoise: {
        available: true,
        maskedSpeechRatio: 0.2,
        severeLowMarginSpeechRatio: 0.1,
        burstsNearSpeech: 2,
        sustainedNoiseRatio: 0.15,
        backgroundNoiseConcern: { level: 'high', message: 'Some speech may be difficult to hear.' },
      },
    })
    result = render(<HandoverReviewPage
      handover={{ id: 'noise-parity', title: 'Ward handover', href: handoverHref('noise-parity'), status: 'completed' }}
      tabs={[{ key: 'details', label: 'Details', href: handoverReviewHref('noise-parity', 'details') }]}
      activeTab="details"
      transcriptionMetadata={metadata}
    />)
    let alert = result.$('[role="alert"]')
    assert.equal(computedStyle(alert).display, 'grid')
    assert.equal(computedStyle(alert).gridTemplateColumns.split(' ').length, 2)
    assert.ok(alert?.querySelector('svg'))
    assert.match(alert?.textContent ?? '', /Some speech may be difficult to hear/)
    result.cleanup()
  })
})
