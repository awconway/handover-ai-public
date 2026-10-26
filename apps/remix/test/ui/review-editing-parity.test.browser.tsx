import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { render } from 'remix/component/test'

import { HandoverReviewPage } from '../../app/ui/handover-review-page.tsx'
import { reviewHref, routes, type ReviewTab } from '../../app/routes.ts'
import { normalizeReviewAnalysis, normalizeTranscriptionMetadata } from '../../app/utils/handover-review.ts'
import { computedStyle } from './styles.ts'

function handoverHref(handoverId: string) {
  return routes.workspace.handover.href({ handoverId })
}

function handoverReviewHref(handoverId: string, reviewTab: ReviewTab) {
  return reviewHref({ handoverId, reviewTab })
}

describe('review editing parity', () => {
  it('persists checklist changes immediately without a visible save control', async () => {
    let originalFetch = window.fetch
    let submitted: FormData | undefined
    window.fetch = async (_input, init) => {
      submitted = init?.body as FormData
      return new Response('', { status: 200 })
    }

    try {
      let analysis = normalizeReviewAnalysis({
        checklistFocus: [{ id: 'identity', label: 'id_check', status: 'missing', note: 'Identity not confirmed' }],
      })
      let result = render(<HandoverReviewPage
        handover={{ id: 'h1', title: 'Handover', href: handoverHref('h1'), status: 'completed' }}
        tabs={[{ key: 'checklist', label: 'Checklist', href: handoverReviewHref('h1', 'checklist') }]}
        activeTab="checklist"
        analysis={analysis}
        checklistAction={routes.actions.updateChecklist.href({ handoverId: 'h1' })}
        csrfToken="csrf"
      />)

      let fallbackSubmit = result.$('form[data-workflow="update-checklist"] button[type="submit"]')
      assert.equal(fallbackSubmit?.closest('noscript')?.tagName, 'NOSCRIPT')
      await result.act(() => (result.$('[data-testid="checklist-toggle-identity"]') as HTMLInputElement).click())

      assert.ok(submitted)
      assert.equal(submitted.get('checklistItemId'), 'identity')
      assert.equal(submitted.get('covered'), 'true')
      assert.equal(submitted.has('summary'), false)
      result.cleanup()
    } finally {
      window.fetch = originalFetch
    }
  })

  it('saves Situation above adjacent SBAR editor overlays and exposes prior versions', async () => {
    let analysis = normalizeReviewAnalysis({
      structuredSummary: {
        situation: 'Stable on room air.',
        background: 'Admitted with pneumonia.',
        assessment: 'Oxygenation has improved.',
        recommendation: 'Review before discharge.',
      },
      structuredSummaryMeta: {
        reviewed: false,
        edits: [{
          section: 'assessment',
          previousValue: 'Oxygenation is improving.',
          nextValue: 'Oxygenation has improved.',
          at: '2026-07-13T02:00:00.000Z',
          byUserId: 'u1',
        }],
        llmDraft: {
          situation: 'Stable on room air.',
          background: 'Admitted with pneumonia.',
          assessment: 'Oxygenation is improving.',
          recommendation: 'Review before discharge.',
        },
      },
    })
    let result = render(<HandoverReviewPage
      handover={{ id: 'h1', title: 'Handover', href: handoverHref('h1'), status: 'completed' }}
      tabs={[{ key: 'summary', label: 'SBAR summary', href: handoverReviewHref('h1', 'summary') }]}
      activeTab="summary"
      analysis={analysis}
      summaryAction={routes.actions.updateSummary.href({ handoverId: 'h1' })}
      summaryReviewAction={routes.actions.updateSummaryReview.href({ handoverId: 'h1' })}
      csrfToken="csrf"
    />)

    let editors = result.container.querySelectorAll('form[data-testid^="inline-editor-"]')
    assert.equal(editors.length, 4)
    for (let editor of editors) {
      assert.ok(editor.querySelector('input[name="section"]'))
      assert.ok(editor.querySelector('input[name="value"]'))
      assert.equal(editor.querySelector('input[name="situation"], input[name="background"], input[name="assessment"], input[name="recommendation"]'), null)
    }
    assert.equal(result.container.querySelectorAll('[data-summary-server-content]').length, 4)
    assert.equal(result.$('[data-review-panel="summary"]')?.tagName, 'DIV')
    assert.doesNotMatch(result.container.textContent ?? '', /Edit SBAR summary/)
    assert.match(result.container.textContent ?? '', /Clinician edits are kept in each section’s version history/)
    assert.match(result.container.textContent ?? '', /Edited/)
    assert.equal(result.$('[data-edited="true"]'), null)
    assert.match(result.$('[data-summary-server-content="assessment"] details')?.textContent ?? '', /View version history.*Oxygenation is improving/s)

    assert.match(result.$('[data-summary-server-content="situation"]')?.textContent ?? '', /Stable on room air/)
    let situationForm = result.$('[data-testid="inline-editor-situation"]') as HTMLFormElement
    let submits = 0
    let submitted: FormData | undefined
    situationForm.addEventListener('submit', (event) => {
      event.preventDefault()
      submits += 1
      submitted = new FormData(situationForm)
    }, { capture: true })
    await result.act(() => result.$('button[aria-label="Edit situation summary"]')?.click())
    assert.equal(computedStyle(situationForm).zIndex, '20')
    assert.equal(computedStyle(result.$('[data-testid="inline-editor-assessment"]')).zIndex, '10')
    let situationEditor = result.$('[role="textbox"][aria-label="Situation summary editor"]') as HTMLDivElement
    situationEditor.innerText = 'Stable after clinician review.'
    await result.act(() => situationEditor.dispatchEvent(new InputEvent('input', { bubbles: true })))
    let save = [...situationForm.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Save')
    await result.act(() => save?.click())

    assert.equal(submits, 1)
    assert.equal(submitted?.get('section'), 'situation')
    assert.equal(submitted?.get('value'), 'Stable after clinician review.')
    assert.equal(result.$('[role="textbox"][aria-label="Situation summary editor"]'), null)
    assert.equal(result.$('[role="textbox"][aria-label="Assessment summary editor"]'), null)
    assert.equal((situationForm.querySelector('input[name="value"]') as HTMLInputElement).value, 'Stable after clinician review.')
    assert.equal(computedStyle(situationForm).zIndex, '10')

    await result.act(() => result.$('button[aria-label="Edit assessment summary"]')?.click())
    assert.ok(result.$('[role="textbox"][aria-label="Assessment summary editor"]'))
    result.cleanup()
  })

  it('opens environmental-noise metric help as the same interactive popover as React', async () => {
    let metadata = normalizeTranscriptionMetadata({
      audioNoise: {
        available: true,
        maskedSpeechRatio: 0.2,
        severeLowMarginSpeechRatio: 0.1,
        burstsNearSpeech: 2,
        sustainedNoiseRatio: 0.15,
        averageSpeechSnrDb: 8.4,
      },
    })
    let result = render(<HandoverReviewPage
      handover={{ id: 'h1', title: 'Handover', href: handoverHref('h1'), status: 'completed' }}
      tabs={[{ key: 'details', label: 'Details', href: handoverReviewHref('h1', 'details') }]}
      activeTab="details"
      transcriptionMetadata={metadata}
    />)

    let trigger = result.$('button[aria-label="About Masked speech"]')
    assert.ok(trigger)
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')

    await result.act(() => trigger?.click())
    let dialog = result.$('[role="dialog"][aria-label="Masked speech"]')
    assert.ok(dialog)
    assert.equal(result.$('button[aria-label="About Masked speech"]')?.getAttribute('aria-expanded'), 'true')
    assert.match(dialog.textContent ?? '', /share of spoken time where the speaker was not clearly above the background noise/i)
    result.cleanup()
  })
})
