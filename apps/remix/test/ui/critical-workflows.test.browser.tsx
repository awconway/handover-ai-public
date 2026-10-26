import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { render } from 'remix/component/test'

import { computedStyle } from './styles.ts'

import {
  HandoverReviewPage,
  InboxAssignmentPanel,
  InboxPage,
} from '../../app/ui/index.ts'
import { NewHandoverForm } from '../../app/assets/new-handover-form.tsx'
import { RECORDING_REQUEST_EVENT } from '../../app/assets/recording-events.ts'
import { SendHandoverDialog } from '../../app/assets/send-handover-dialog.tsx'
import { reviewHref, routes } from '../../app/routes.ts'
import { normalizeReviewAnalysis } from '../../app/utils/handover-review.ts'

const handoverHref = routes.workspace.handover.href({ handoverId: 'h1' })
const createHandoverAction = routes.actions.createHandover.href()
const createTaskAction = routes.actions.createTask.href({ handoverId: 'h1' })
const deleteHandoverAction = routes.actions.deleteHandover.href({ handoverId: 'h1' })
const extendHandoverAction = routes.actions.extendHandover.href({ handoverId: 'h1' })
const metadataAction = routes.actions.updateMetadata.href({ handoverId: 'h1' })
const assignmentAction = routes.actions.createAssignments.href()
const checklistAction = routes.actions.updateChecklist.href({ handoverId: 'h1' })
const retryHandoverAction = routes.actions.retryHandover.href({ handoverId: 'h1' })
const discardFailedHandoverAction = routes.actions.discardFailedHandover.href({ handoverId: 'h1' })
const failedHandoverHref = routes.workspace.handover.href({ handoverId: 'h-failed' })

function handoverReviewHref(reviewTab: Parameters<typeof reviewHref>[0]['reviewTab'], handoverId = 'h1') {
  return reviewHref({ handoverId, reviewTab })
}

describe('critical native Remix workflows', () => {
  it('matches the compact recorder-first handover composer and reveals the testing transcript on request', async () => {
    let result = render(<NewHandoverForm action={createHandoverAction} csrfToken="csrf" mode="individual" defaultDepartment="Medicine" presentation="inline" />)
    assert.ok(result.$('[data-testid="new-handover-form"]'))
    assert.ok(result.$('[data-analytics-id="handover-start-recording"]'))
    assert.equal(result.$('textarea[name="manualTranscript"]'), null)
    assert.equal(result.$('[data-testid="handover-consent"]')?.getAttribute('required'), '')
    assert.equal(result.$('[data-testid="recording-dock"]'), null)
    let source = result.$('input[name="sourceDepartment"]') as HTMLInputElement
    source.value = 'Intensive care'
    await result.act(() => source.dispatchEvent(new InputEvent('input', { bubbles: true })))
    assert.match((result.$('input[name="title"]') as HTMLInputElement).value, /Intensive care/)
    await result.act(() => result.$('[data-analytics-id="handover-show-manual-entry"]')?.click())
    assert.ok(result.$('textarea[name="manualTranscript"]'))
    assert.ok(result.$('[data-analytics-id="handover-create-from-manual-entry"]'))
    result.cleanup()
  })

  it('does not submit a shift binding from the individual composer when shifts exist', () => {
    let result = render(<NewHandoverForm
      action={createHandoverAction}
      csrfToken="csrf"
      mode="individual"
      shifts={[{
        id: 'shift-1',
        title: 'Day shift',
        department: 'Medicine',
      }]}
      defaultShiftId="shift-1"
      defaultDepartment="Medicine"
      presentation="inline"
    />)
    let form = result.$('form[data-workflow="create-handover"]') as HTMLFormElement

    assert.equal((form.querySelector('input[name="shiftId"]') as HTMLInputElement).value, '')
    assert.equal(new FormData(form).get('shiftId'), '')
    result.cleanup()
  })

  it('supports placing, adding, or dismissing an inbox assignment', async () => {
    let placeAction = routes.actions.placeAssignment.href({ assignmentId: 'a1' })
    let addToIndividualAction = routes.actions.addAssignmentToIndividual.href({ assignmentId: 'a1' })
    let dismissAction = routes.actions.dismissAssignment.href({ assignmentId: 'a1' })
    let result = render(<InboxAssignmentPanel csrfToken="csrf" shifts={[{ id: 's1', title: 'Evening', department: 'Medicine', href: routes.workspace.shift.href({ shiftId: 's1' }) }]} assignment={{ id: 'a1', assignmentId: 'a1', title: 'Patient handover', href: handoverHref, assignedBy: 'Casey Bennett', assignedAt: '2026-07-13T04:30:00.000Z', direction: 'incoming', routeLabel: 'Ward A', placeAction, addToIndividualAction, dismissAction }} />)
    assert.match(result.container.textContent ?? '', /Place in shift/)
    assert.match(result.container.textContent ?? '', /Add to individual/)
    assert.match(result.container.textContent ?? '', /Remove/)
    assert.match(result.container.textContent ?? '', /From Casey Bennett/)
    assert.equal(result.$('form[data-workflow="add-handover-to-individual"]')?.getAttribute('action'), addToIndividualAction)
    assert.equal(result.$('form[data-workflow="dismiss-handover"]')?.getAttribute('action'), dismissAction)
    await result.act(() => result.$('button[aria-haspopup="dialog"]')?.click())
    assert.equal(result.$('dialog[open]')?.tagName, 'DIALOG')
    assert.equal(result.$('form[data-workflow="place-handover"]')?.getAttribute('data-study-task'), 'task-place-handover')
    assert.match(result.container.textContent ?? '', /Place received handover/)
    assert.match(result.container.textContent ?? '', /Choose which shift should receive this handover/)
    assert.match(result.container.textContent ?? '', /Receiving handover/)
    assert.match(result.container.textContent ?? '', /From Casey Bennett · Ward A/)
    assert.match(result.container.textContent ?? '', /remain linked back to its source shift/)
    result.cleanup()
  })

  it('renders the deployed inbox count and empty card surface', () => {
    let shiftSelectionHref = routes.workspace.shiftSelection.href()
    let result = render(<InboxPage assignments={[]} shifts={[]} startShiftHref={shiftSelectionHref} csrfToken="csrf" />)
    assert.ok(result.$('[data-testid="inbox-page"]'))
    assert.match(result.container.textContent ?? '', /Received handovers/)
    assert.match(result.container.textContent ?? '', /0 unactioned/)
    assert.match(result.container.textContent ?? '', /No unactioned handovers/)
    assert.equal(result.$(`a[href="${shiftSelectionHref}"]`)?.textContent?.trim(), 'Start shift')
    result.cleanup()
  })

  it('exposes checklist save, complete action mutations, and processing retry', async () => {
    let analysis = normalizeReviewAnalysis({
      checklistFocus: [{ id: 'airway', label: 'assess_airway', status: 'addressed', note: 'Airway covered' }],
      patients: [
        { patientKey: 'arthur-dent', displayName: 'Arthur Dent', location: 'Bed 12', lastConfirmedPoint: 'Repeat observations are due at 16:00.', restartPrompt: 'Restart with the observation plan.', uncertainties: [] },
        { patientKey: 'ford-prefect', displayName: 'Ford Prefect', location: 'Bed 13', uncertainties: [] },
      ],
    })
    let tasks = [
      { id: 't1', label: 'Review oxygen target', completed: false, due: '14 Jul 2026, 3:30 PM', dueAt: '2026-07-14T05:30:00.000Z', reminderEnabled: true, patientKey: 'arthur-dent', handoverId: 'h1', updateAction: routes.actions.updateTask.href({ taskId: 't1' }), deleteAction: routes.actions.deleteTask.href({ taskId: 't1' }) },
      { id: 't2', label: 'Confirm discharge transport', completed: true, reminderEnabled: false, patientKey: 'ford-prefect', handoverId: 'h1', updateAction: routes.actions.updateTask.href({ taskId: 't2' }), deleteAction: routes.actions.deleteTask.href({ taskId: 't2' }) },
    ]
    let tabs = [{ key: 'checklist', label: 'Checklist', href: handoverReviewHref('checklist') }, { key: 'tasks', label: 'Actions', href: handoverReviewHref('tasks') }]
    let result = render(<HandoverReviewPage handover={{ id: 'h-failed', title: 'Handover', href: failedHandoverHref, status: 'failed' }} tabs={tabs} activeTab="checklist" analysis={analysis} checklistAction={checklistAction} retryAction={retryHandoverAction} discardFailedAction={discardFailedHandoverAction} deleteAction={deleteHandoverAction} taskAction={createTaskAction} tasks={tasks} csrfToken="csrf" />)
    assert.ok(result.$('form[data-workflow="update-checklist"]'))
    assert.ok(result.$('[data-testid="checklist-editor"]'))
    assert.ok(result.$('[data-testid="retry-processing"]'))
    assert.ok(result.$('[data-testid="discard-failed-handover"]'))
    assert.equal(result.$('[data-testid="review-action-delete"]'), null)
    assert.equal(result.container.textContent?.includes('Open the handover to retry or inspect details'), false)
    result.cleanup()

    result = render(<HandoverReviewPage handover={{ id: 'h1', title: 'Handover', href: handoverHref, status: 'completed' }} tabs={tabs} activeTab="tasks" analysis={analysis} taskAction={createTaskAction} tasks={tasks} csrfToken="csrf" />)
    assert.ok(result.$('[data-testid="task-toggle-t1"]'))
    assert.ok(result.$('form[data-workflow="create-task"]'))
    let patientSelect = result.$('[data-testid="new-task-patient-select"]') as HTMLButtonElement
    assert.ok(patientSelect)
    assert.equal(patientSelect.getAttribute('data-value'), 'arthur-dent')
    assert.equal((result.$('form[data-workflow="create-task"] input[name="patientKey"]') as HTMLInputElement).value, 'arthur-dent')
    assert.equal(patientSelect.parentElement?.querySelectorAll('[role="option"]').length, 2)
    assert.equal(result.$('[data-testid="new-task-due-picker"]')?.textContent?.trim(), 'No due date set')
    assert.equal(result.$('form[data-workflow="update-task-owner"]'), null)
    assert.equal(result.$('[data-testid="new-task-owner-select"]'), null)
    assert.equal(result.$('form[data-workflow="create-task"] input[name="ownerRole"]'), null)
    assert.ok(result.$('form[data-workflow="update-task-reminder"]'))
    assert.ok(result.$('[data-testid="task-sort"]'))

    let scope = result.$('[data-testid="task-scope-filter"]') as HTMLButtonElement
    await result.act(() => scope.click())
    let patientScope = [...(scope.parentElement?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
      .find((option) => option.textContent?.includes('Arthur Dent'))
    assert.ok(patientScope)
    await result.act(async () => {
      patientScope.click()
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await result.act(() => {})
    assert.ok(result.$('[data-testid="patient-task-row-t1"]'))
    assert.equal(result.$('[data-testid="patient-task-row-t2"]'), null)

    await result.act(() => result.$('[data-testid="task-edit-t1"]')?.click())
    let editForm = result.$('[data-testid="task-edit-form-t1"]')
    assert.equal((editForm?.querySelector('input[name="dueAt"]') as HTMLInputElement | null)?.value, '2026-07-14T05:30:00.000Z')
    assert.equal(editForm?.querySelector('[data-testid="task-due-picker-t1"]')?.textContent?.trim(), '14 Jul 2026, 3:30 PM')
    await result.act(() => editForm?.querySelector<HTMLButtonElement>('[data-testid="task-due-picker-t1"]')?.click())
    assert.ok(result.$('[data-testid="task-due-picker-t1-calendar"]'))
    assert.equal(result.$('[data-testid="task-due-picker-t1-day-2026-07-14"]')?.getAttribute('aria-selected'), 'true')
    assert.equal((result.$('#task-t1-due-at-time') as HTMLInputElement | null)?.type, 'time')
    assert.equal(editForm?.querySelector('input[name="_intent"]')?.getAttribute('value'), 'details')
    await result.act(() => result.$('[data-testid="task-due-picker-t1"]')?.click())
    editForm = result.$('[data-testid="task-edit-form-t1"]')
    let submitCount = 0
    editForm?.addEventListener('submit', (event) => {
      event.preventDefault()
      submitCount += 1
    })
    let titleInput = editForm?.querySelector('input[name="label"]') as HTMLInputElement
    await result.act(() => titleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    assert.equal(submitCount, 1)
    result.cleanup()
  })

  it('keeps the React compact review header, action row, and tab grid without changing desktop structure', async () => {
    let analysis = normalizeReviewAnalysis({
      patients: [{ patientKey: 'arthur-dent', displayName: 'Arthur Dent', location: 'Bed 12', uncertainties: [] }],
      structuredSummary: { situation: 'Stable', background: 'Admitted', assessment: 'Improving', recommendation: 'Review' },
    })
    let tabs = [
      { key: 'details', label: 'Details', href: handoverReviewHref('details') },
      { key: 'checklist', label: 'Checklist', href: handoverReviewHref('checklist') },
      { key: 'summary', label: 'SBAR summary', href: handoverReviewHref('summary') },
      { key: 'uncertainty', label: 'Uncertainty', href: handoverReviewHref('uncertainty') },
      { key: 'tasks', label: 'Actions', href: handoverReviewHref('tasks') },
      { key: 'communication', label: 'Communication', href: handoverReviewHref('communication') },
      { key: 'transcript', label: 'Transcript', href: handoverReviewHref('transcript') },
    ]
    let result = render(<HandoverReviewPage
      handover={{ id: 'h1', title: 'Handover', href: handoverHref, status: 'completed', updatedAt: '2026-07-13T04:30:00.000Z' }}
      tabs={tabs}
      activeTab="details"
      analysis={analysis}
      patientKey="arthur-dent"
      patientDisplayName="Arthur Dent"
      patientLocation="Bed 12"
      metadataAction={metadataAction}
      extendAction={extendHandoverAction}
      assignmentAction={assignmentAction}
      recipients={[{ id: 'user-2', label: 'Jordan Day', description: 'Registrar · Medicine' }]}
      deleteAction={deleteHandoverAction}
      csrfToken="csrf"
    />)

    let desktop = matchMedia('(min-width: 768px)').matches
    let workspace = result.$('[data-testid="handover-review-workspace"]')
    assert.equal(computedStyle(workspace).gap, desktop ? '20px' : '12px')

    let patientHeader = result.$('[data-testid="review-patient-header"]')
    assert.equal(computedStyle(patientHeader).paddingLeft, desktop ? '24px' : '0px')
    let compactPatient = result.$('[data-testid="review-patient-summary-mobile"]')
    assert.equal(compactPatient?.tagName, 'A')
    assert.equal(computedStyle(compactPatient).display, desktop ? 'none' : 'flex')
    assert.match(compactPatient?.textContent ?? '', /Arthur Dent/)
    assert.match(compactPatient?.textContent ?? '', /Edit patient details/)
    assert.equal(computedStyle(result.$('[data-testid="review-patient-summary-desktop"]')).display, desktop ? 'flex' : 'none')

    let actionGrid = result.$('[data-testid="review-actions-grid"]')
    assert.equal(computedStyle(actionGrid).display, 'grid')
    if (desktop) assert.equal(computedStyle(actionGrid).gridTemplateColumns.split(' ').length, 1)
    let primaryActionRow = result.$('[data-testid="review-actions-primary-row"]')
    assert.equal(computedStyle(primaryActionRow).display, desktop ? 'contents' : 'grid')
    if (!desktop) {
      let columns = computedStyle(primaryActionRow).gridTemplateColumns.split(' ')
      assert.equal(columns.length, 3)
      assert.equal(columns[1], '56px')
      assert.equal(columns[2], '56px')
    }
    let recommence = result.$('[data-testid="review-action-recommence"]')
    let send = result.$('[data-testid="review-action-send"]')
    let deleteAction = result.$('[data-testid="review-action-delete"]')
    for (let [index, button] of [recommence, send, deleteAction].entries()) {
      assert.equal(computedStyle(button).gridColumnStart, desktop ? 'auto' : String(index + 1))
      assert.equal(computedStyle(button).gridRowStart, desktop ? 'auto' : '1')
      assert.equal(computedStyle(button).height, desktop ? '32px' : '56px')
      assert.equal(computedStyle(button?.querySelector('svg')).width, desktop ? '16px' : '20px')
    }
    assert.equal(recommence?.tagName, 'BUTTON')
    assert.equal(result.$('textarea[name="manualTranscript"]'), null)
    assert.equal(result.$('input[name="audio"]'), null)
    assert.equal(result.$('[data-testid="review-action-send-mobile-label"]')?.textContent, 'Send')
    assert.equal(result.$('[data-testid="review-action-delete-mobile-label"]')?.textContent, 'Delete')
    assert.equal(computedStyle(result.$('[data-testid="review-action-send-desktop-label"]')).display, desktop ? 'block' : 'none')
    assert.equal(computedStyle(result.$('[data-testid="review-action-delete-desktop-label"]')).display, desktop ? 'block' : 'none')

    let compactTabs = result.$('nav[aria-label="Review tabs"]')
    assert.equal(computedStyle(compactTabs).display, desktop ? 'none' : 'grid')
    if (!desktop) assert.equal(computedStyle(compactTabs).gridTemplateColumns.split(' ').length, 4)
    let compactMetric = compactTabs?.querySelector('[data-tab-meta]')
    assert.equal(computedStyle(compactMetric).height, '20px')
    assert.equal(computedStyle(compactMetric).fontSize, '11px')
    assert.equal(computedStyle(compactMetric).paddingLeft, '8px')
    assert.equal(computedStyle(result.$('[data-testid="review-tab-details"]')).backgroundColor, 'rgba(0, 0, 0, 0)')
    assert.equal(computedStyle(result.$('nav[aria-label="Review sections"]')).display, desktop ? 'grid' : 'none')
    await result.act(() => result.$('[data-testid="review-action-delete"]')?.click())
    assert.equal(result.$('dialog[open]')?.tagName, 'DIALOG')
    assert.equal(result.$('form[data-workflow="delete-handover"]')?.getAttribute('action'), deleteHandoverAction)
    result.cleanup()
  })

  it('starts a recommenced handover recording directly with the saved restart cue', async () => {
    let request: {
      accepted: boolean
      submitAction: string
      mode?: string
      restartCue?: string
      formData: FormData
    } | undefined
    let accept = (event: Event) => {
      request = (event as CustomEvent<typeof request>).detail
      if (request) request.accepted = true
    }
    window.addEventListener(RECORDING_REQUEST_EVENT, accept)

    try {
      let analysis = normalizeReviewAnalysis({
        patients: [{
          patientKey: 'arthur-dent',
          displayName: 'Arthur Dent',
          location: 'Bed 12',
          lastConfirmedPoint: 'Repeat observations are due at 16:00.',
          restartPrompt: 'Restart with the observation plan.',
          uncertainties: [],
        }],
      })
      let result = render(<HandoverReviewPage
        handover={{ id: 'h1', title: 'Arthur Dent handover', href: handoverHref, status: 'completed' }}
        tabs={[{ key: 'details', label: 'Details', href: handoverReviewHref('details') }]}
        activeTab="details"
        analysis={analysis}
        patientKey="arthur-dent"
        patientDisplayName="Arthur Dent"
        extendAction={extendHandoverAction}
        csrfToken="csrf"
      />)

      assert.equal(result.$('[data-testid="review-action-recommence"]')?.textContent?.trim(), 'Start recording again')
      await result.act(() => result.$('[data-testid="review-action-recommence"]')?.click())

      assert.ok(request)
      assert.equal(request.submitAction, extendHandoverAction)
      assert.equal(request.mode, 'extend')
      assert.equal(request.restartCue, 'Repeat observations are due at 16:00.')
      assert.equal(request.formData.has('manualTranscript'), false)
      assert.equal(result.$('[data-testid="review-action-recommence"]')?.textContent?.trim(), 'Recommencing handover')
      assert.equal(result.$(`form[action="${extendHandoverAction}"]`), null)
      result.cleanup()
    } finally {
      window.removeEventListener(RECORDING_REQUEST_EVENT, accept)
    }
  })

  it('lets a sole preselected handover recipient be cleared and reselected', async () => {
    let result = render(<SendHandoverDialog
      action={assignmentAction}
      handoverId="h1"
      handoverTitle="Arthur Dent handover"
      recipients={[{ id: 'user-2', label: 'Jordan Day', description: 'Registrar · Medicine' }]}
      csrfToken="csrf"
    />)

    await result.act(() => result.$('[data-testid="review-action-send"]')?.click())

    let form = result.$('form[data-workflow="send-handover"]') as HTMLFormElement
    let recipient = result.$('button[aria-pressed="true"]') as HTMLButtonElement
    let submit = form.querySelector('button[type="submit"]') as HTMLButtonElement
    assert.equal((form.querySelector('input[name="assignedToUserId"]') as HTMLInputElement).value, 'user-2')
    assert.equal(submit.disabled, false)
    assert.equal(computedStyle(submit).whiteSpace, 'nowrap')
    assert.equal(computedStyle(submit.querySelector('svg')).width, '16px')
    assert.equal(computedStyle(submit.querySelector('svg')).height, '16px')
    assert.match(result.$('[role="status"]')?.textContent ?? '', /Jordan Day is selected/)

    await result.act(() => recipient.click())

    form = result.$('form[data-workflow="send-handover"]') as HTMLFormElement
    recipient = result.$('button[aria-pressed="false"]') as HTMLButtonElement
    submit = form.querySelector('button[type="submit"]') as HTMLButtonElement
    assert.equal(form.querySelector('input[name="assignedToUserId"]'), null)
    assert.equal(new FormData(form).has('assignedToUserId'), false)
    assert.equal(submit.disabled, true)
    assert.match(result.$('[role="status"]')?.textContent ?? '', /No receiving clinician is selected/)
    assert.match(result.container.textContent ?? '', /Send handover button stays disabled until a clinician is selected/)

    await result.act(() => recipient.click())

    form = result.$('form[data-workflow="send-handover"]') as HTMLFormElement
    assert.equal((form.querySelector('input[name="assignedToUserId"]') as HTMLInputElement).value, 'user-2')
    assert.equal((form.querySelector('button[type="submit"]') as HTMLButtonElement).disabled, false)
    assert.equal(result.$('button[aria-pressed="true"]')?.textContent?.trim(), 'Jordan Day')
    result.cleanup()
  })

  it('switches and clears a selection when several handover recipients are available', async () => {
    let result = render(<SendHandoverDialog
      action={assignmentAction}
      handoverId="h1"
      handoverTitle="Arthur Dent handover"
      recipients={[
        { id: 'user-2', label: 'Jordan Day', description: 'Registrar · Medicine' },
        { id: 'user-3', label: 'Casey Night', description: 'Nurse · ICU' },
      ]}
    />)

    await result.act(() => result.$('[data-testid="review-action-send"]')?.click())

    let form = result.$('form[data-workflow="send-handover"]') as HTMLFormElement
    let recipientButtons = [...result.container.querySelectorAll<HTMLButtonElement>('[aria-label="Receiving clinicians"] button')]
    assert.equal(form.querySelector('input[name="assignedToUserId"]'), null)
    assert.equal((form.querySelector('button[type="submit"]') as HTMLButtonElement).disabled, true)

    await result.act(() => recipientButtons[0]?.click())
    form = result.$('form[data-workflow="send-handover"]') as HTMLFormElement
    assert.equal((form.querySelector('input[name="assignedToUserId"]') as HTMLInputElement).value, 'user-2')
    assert.equal(result.container.querySelectorAll('button[aria-pressed="true"]').length, 1)

    recipientButtons = [...result.container.querySelectorAll<HTMLButtonElement>('[aria-label="Receiving clinicians"] button')]
    await result.act(() => recipientButtons[1]?.click())
    form = result.$('form[data-workflow="send-handover"]') as HTMLFormElement
    assert.equal((form.querySelector('input[name="assignedToUserId"]') as HTMLInputElement).value, 'user-3')
    assert.equal(result.$('button[aria-pressed="true"]')?.textContent?.trim(), 'Casey Night')

    await result.act(() => (result.$('button[aria-pressed="true"]') as HTMLButtonElement).click())
    form = result.$('form[data-workflow="send-handover"]') as HTMLFormElement
    assert.equal(form.querySelector('input[name="assignedToUserId"]'), null)
    assert.equal((form.querySelector('button[type="submit"]') as HTMLButtonElement).disabled, true)
    result.cleanup()
  })

  it('matches the route-backed review metadata, readiness, uncertainty, and communication surfaces', async () => {
    let analysis = normalizeReviewAnalysis({
      analysisReadiness: { patients: true, uncertainty: true, communication: true },
      patients: [{
        patientKey: 'arthur-dent',
        displayName: 'Arthur Dent',
        location: 'Bed 12',
        uncertainties: [{ id: 'u1', statement: 'Confirm the oxygen target', confidence: 'medium', verificationNeed: 'Check the chart', linkedTaskId: null }],
      }],
      structuredSummary: { situation: 'Stable', background: 'Admitted', assessment: 'Improving', recommendation: 'Review' },
      structuredSummaryMeta: { reviewed: false },
      communicationRisks: [{ id: 'risk-1', type: 'ambiguity', severity: 'medium', evidence: 'Target was unclear', mitigation: 'Confirm the target' }],
      interruptionAssessment: { status: 'possible', summary: 'A possible interruption occurred.', evidence: ['A second speaker entered.'], recommendation: 'Confirm the displaced point.' },
      feedback: { whatWorked: ['Clear introduction'], needsAttention: ['Confirm target'], repeatedInformation: [], coachingTips: ['Use read-back'], durationComment: 'Appropriate duration' },
    })
    assert.ok(analysis)
    let tabs = [
      { key: 'details', label: 'Details', href: handoverReviewHref('details') },
      { key: 'summary', label: 'SBAR summary', href: handoverReviewHref('summary'), disabled: true },
      { key: 'uncertainty', label: 'Uncertainty', href: handoverReviewHref('uncertainty') },
      { key: 'communication', label: 'Communication', href: handoverReviewHref('communication') },
    ]
    let result = render(<HandoverReviewPage
      handover={{ id: 'h1', title: 'Handover', href: handoverHref, status: 'completed', direction: 'incoming' }}
      tabs={tabs}
      activeTab="details"
      analysis={analysis}
      participants={['Casey Bennett', 'Jordan Day']}
      patientKey="arthur-dent"
      patientDisplayName="Arthur Dent"
      metadataAction={metadataAction}
      deleteAction={deleteHandoverAction}
      inboxPlacement={{
        action: routes.actions.placeAssignment.href({ assignmentId: 'a1' }),
        assignmentTitle: 'Handover',
        assignedBy: 'Ford Prefect',
        sourceLabel: 'Night shift · Emergency',
        shifts: [{ id: 'shift-1', title: 'Day shift', department: 'General Medicine' }],
      }}
      csrfToken="csrf"
    />)
    assert.match(result.container.textContent ?? '', /Arthur Dent/)
    assert.doesNotMatch(result.container.textContent ?? '', /Location not stated/)
    assert.equal(result.$('[data-testid="review-tab-summary"]')?.getAttribute('aria-disabled'), 'true')
    assert.equal(result.$('[data-testid="review-tab-summary"]')?.getAttribute('href'), null)
    assert.equal(result.$('[data-testid="review-patient-edit-desktop"]')?.textContent?.trim(), 'Edit patient details')
    assert.match(result.container.textContent ?? '', /Place in shift/)
    assert.equal(result.$('#edit-patient-details'), null)
    assert.equal(result.$('form[data-workflow="delete-handover"]'), null)
    await result.act(() => result.$('[data-testid="review-action-delete"]')?.click())
    assert.match(result.container.textContent ?? '', /Delete handover\?/)
    assert.equal(result.$('form[data-workflow="delete-handover"]')?.getAttribute('action'), deleteHandoverAction)
    assert.match(result.container.textContent ?? '', /Confirm delete handover/)
    result.cleanup()

    result = render(<HandoverReviewPage
      handover={{ id: 'h1', title: 'Handover', href: handoverHref, status: 'completed', direction: 'incoming' }}
      tabs={tabs}
      activeTab="details"
      analysis={analysis}
      participants={['Casey Bennett', 'Jordan Day']}
      patientKey="arthur-dent"
      patientDisplayName="Arthur Dent"
      editPatientDetails
      metadataAction={metadataAction}
      csrfToken="csrf"
    />)
    assert.equal(result.$('#edit-patient-details')?.tagName, 'FORM')
    assert.ok(result.$('a[aria-label="Cancel patient details edit"]'))
    assert.equal((result.$('input[name="participants"]') as HTMLInputElement).value, 'Casey Bennett, Jordan Day')
    assert.equal((result.$('input[name="patientDisplayName-0"]') as HTMLInputElement).value, 'Arthur Dent')
    assert.ok(result.$('button[type="submit"]')?.textContent)
    result.cleanup()

    result = render(<HandoverReviewPage
      handover={{ id: 'h1', title: 'Handover', href: handoverHref, status: 'completed' }}
      tabs={tabs}
      activeTab="uncertainty"
      analysis={analysis}
      transcriptionMetadata={{ interruptionSignals: [], noiseSignals: [], audioNoise: null, segments: [{ id: 's1', startMs: 0, text: 'Please confirm the oxygen target before transfer.', speaker: 'giver' }] }}
      uncertaintyTaskActions={{ u1: routes.actions.createUncertaintyTask.href({ handoverId: 'h1', uncertaintyId: 'u1' }) }}
      csrfToken="csrf"
    />)
    assert.ok(result.$('[data-testid="uncertainty-transcript-context"]'))
    assert.equal(result.$(`form[action="${routes.actions.createUncertaintyTask.href({ handoverId: 'h1', uncertaintyId: 'u1' })}"] input[name="ownerRole"]`), null)
    assert.match(result.container.textContent ?? '', /Create verification task/)
    result.cleanup()

    result = render(<HandoverReviewPage
      handover={{ id: 'h1', title: 'Handover', href: handoverHref, status: 'completed' }}
      tabs={tabs}
      activeTab="communication"
      analysis={analysis}
      transcriptionMetadata={{ interruptionSignals: ['Overlapping speech'], noiseSignals: [], audioNoise: null, segments: [] }}
      viewerPerspective="receiving"
      assignmentAction={assignmentAction}
      recipients={[{ id: 'user-2', label: 'Jordan Day', description: 'Registrar · Medicine' }]}
    />)
    assert.match(result.container.textContent ?? '', /Possible/)
    assert.match(result.container.textContent ?? '', /Assessment evidence/)
    assert.match(result.container.textContent ?? '', /Confirm the displaced point/)
    assert.doesNotMatch(result.container.textContent ?? '', /What worked/)
    assert.equal(result.$('form[data-workflow="send-handover"]'), null)
    await result.act(() => result.$('[data-testid="review-action-send"]')?.click())
    assert.equal(result.$('dialog[data-analytics-id="send-handover-dialog"]')?.tagName, 'DIALOG')
    assert.equal(result.$('form[data-workflow="send-handover"]')?.getAttribute('action'), assignmentAction)
    result.cleanup()

  })
})
