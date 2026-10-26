import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { render } from 'remix/component/test'

import { computedStyle } from './styles.ts'

import { IndividualPage, LoginPage, ModeHomePage, PatientWorkspacePage, ShiftBoardPage, ShiftSelectionPage } from '../../app/ui/index.ts'
import { taskDueLocalValue } from '../../app/assets/task-dates.ts'
import { patientWorkspaceActionHref, patientWorkspaceHref, reviewHref, routes } from '../../app/routes.ts'

const shiftHref = routes.workspace.shift.href({ shiftId: 's1' })
const patientHref = routes.workspace.patient.href({ shiftId: 's1', patientKey: 'p1' })
const patientActionsHref = patientWorkspaceHref({ shiftId: 's1', patientKey: 'p1', tab: 'actions' })
const patientAddActionHref = patientWorkspaceActionHref({ shiftId: 's1', patientKey: 'p1', tab: 'actions', action: 'add' })
const createHandoverAction = routes.actions.createHandover.href()
const createTaskAction = routes.actions.createTask.href({ handoverId: 'h1' })
const updateTaskAction = routes.actions.updateTask.href({ taskId: 't1' })
const deleteTaskAction = routes.actions.deleteTask.href({ taskId: 't1' })
const reviewPatientFieldAction = routes.actions.reviewPatientField.href({ shiftId: 's1', patientKey: 'p1', fieldKey: 'situation' })

describe('native Handover AI pages', () => {
  it('keeps the mobile workflow identity and sign-out control on one row', () => {
    let result = render(<ModeHomePage
      session={{ user: { id: 'u1', fullName: 'Avery Long Clinician Name', occupation: 'Registered nurse', department: 'General Medicine' } }}
      shiftHref={routes.workspace.shiftSelection.href()}
      individualHref={routes.workspace.individual.href()}
      signOutAction={routes.auth.signOut.href()}
      csrfToken="csrf"
    />)
    let hero = result.$('[data-testid="mode-home-hero"]')
    let row = result.$('[data-testid="mode-home-session-row"]')
    let identity = result.$('[data-testid="mode-home-session-identity"]')
    let wide = matchMedia('(min-width: 640px)').matches
    assert.equal(computedStyle(hero).minWidth, '0px')
    assert.equal(computedStyle(row).minWidth, '0px')
    assert.equal(computedStyle(row).maxWidth, '100%')
    assert.equal(computedStyle(row).flexWrap, wide ? 'wrap' : 'nowrap')
    assert.equal(computedStyle(identity).minWidth, '0px')
    assert.equal(computedStyle(identity).flexGrow, wide ? '0' : '1')
    assert.equal(computedStyle(identity).overflow, wide ? 'visible' : 'hidden')
    assert.equal(computedStyle(identity).textOverflow, wide ? 'clip' : 'ellipsis')
    assert.equal(computedStyle(identity).whiteSpace, wide ? 'normal' : 'nowrap')
    assert.ok(row!.getBoundingClientRect().width <= hero!.getBoundingClientRect().width)
    assert.equal(identity?.getAttribute('title'), 'Avery Long Clinician Name · Registered nurse · General Medicine')
    assert.equal(computedStyle(row?.querySelector(`form[action="${routes.auth.signOut.href()}"]`)).flexShrink, '0')
    assert.equal(row?.querySelector('button[type="submit"]')?.textContent?.trim(), 'Sign out')
    result.cleanup()
  })

  it('renders accessible sign-in and registration forms', () => {
    let result = render(<LoginPage users={[{ id: 'u1', fullName: 'Alex Morgan', occupation: 'Registrar', department: 'Medicine' }]} signInAction={routes.auth.signIn.action.href()} registerAction={routes.auth.register.action.href()} csrfToken="test-token" />)
    assert.match(result.container.textContent ?? '', /Sign in before you start/)
    assert.match(result.container.textContent ?? '', /Continue as this clinician/)
    assert.doesNotMatch(result.container.textContent ?? '', /4 handovers|2 shifts/)
    assert.equal(result.$$('form').length, 2)
    assert.equal(result.$('input[name="_csrf"]')?.getAttribute('value'), 'test-token')
    assert.equal(result.$('input[name="fullName"]')?.getAttribute('required'), '')
    let label = result.$('label[for="register-full-name"]')!
    assert.equal(label.getBoundingClientRect().width, label.parentElement!.getBoundingClientRect().width)
    result.cleanup()
  })

  it('renders an actionable individual-workspace empty state', () => {
    let result = render(<IndividualPage
      createAction={createHandoverAction}
      csrfToken="csrf"
      session={{ user: { id: 'u1', fullName: 'Alex Morgan', occupation: 'Registrar', department: 'Medicine' } }}
      handovers={[]}
    />)
    assert.match(result.container.textContent ?? '', /New handover/)
    assert.ok(result.$('form[data-workflow="create-handover"]'))
    assert.equal((result.$('input[name="sourceDepartment"]') as HTMLInputElement | null)?.value, 'Medicine')
    assert.match(result.container.textContent ?? '', /No individual handovers yet/)
    result.cleanup()
  })

  it('shows failed and active individual handover status while preserving available previews', () => {
    let cases = [
      { status: 'failed', subtitle: 'Open the handover to retry or inspect details.', label: 'Processing failed' },
      { status: 'failed', subtitle: 'Patient A · Bed 1', label: 'Processing failed' },
      { status: 'queued', subtitle: 'Queued for transcription and analysis.', label: 'Queued' },
      { status: 'transcribing', subtitle: 'Transcribing the handover so analysis can begin.', label: 'Transcribing' },
      { status: 'analysing', subtitle: 'Patient B · Bed 2', label: 'Analysing' },
    ] as const

    for (let item of cases) {
      let href = reviewHref({ handoverId: 'h1', reviewTab: 'details' })
      let result = render(<IndividualPage handovers={[{ id: 'h1', title: 'Recorded handover', href, ...item }]} />)
      let row = result.$('[data-testid="handover-row-h1"]')
      assert.equal(row?.querySelector('[data-processing-status]')?.textContent, item.label)
      assert.ok(row?.textContent?.includes(item.subtitle))
      assert.doesNotMatch(row?.textContent ?? '', /Ready for review/)
      assert.equal(row?.getAttribute('href'), href)
      result.cleanup()
    }
  })

  it('preserves shift defaults, notes, counts, and local timestamp markup', () => {
    let result = render(<ShiftSelectionPage
      newShiftAction={routes.actions.createShift.href()}
      defaultTitle="Day shift"
      defaultDepartment="Medicine"
      assignedUserId="u1"
      shifts={[{ id: 's1', title: 'Day shift', department: 'Medicine', notes: 'Ward 5 cover', patientCount: 2, handoverCount: 3, createdAt: '2026-07-13T01:02:00.000Z', href: shiftHref }]}
    />)
    assert.equal((result.$('input[name="title"]') as HTMLInputElement | null)?.value, 'Day shift')
    assert.equal((result.$('input[name="department"]') as HTMLInputElement | null)?.value, 'Medicine')
    assert.equal((result.$('input[name="assignedUserIds"]') as HTMLInputElement | null)?.value, '["u1"]')
    assert.match(result.$('[data-testid="shift-card-s1"]')?.textContent ?? '', /Ward 5 cover/)
    assert.equal(result.$('[data-testid="shift-card-s1"] time')?.getAttribute('datetime'), '2026-07-13T01:02:00.000Z')
    result.cleanup()
  })

  it('keeps priority and patient navigation in the shift board while handover choices stay in the patient workspace', () => {
    let result = render(<ShiftBoardPage
      shift={{ id: 's1', title: 'Evening cover', department: 'Medicine', href: shiftHref, handoverCount: 1 }}
      patients={[{ key: 'p1', displayName: 'Patient A', bed: 'Bed 4', priority: 'high', href: patientHref }]}
      createHandoverAction={createHandoverAction}
      session={{ user: { id: 'u1', fullName: 'Alex Morgan', occupation: 'Registrar', department: 'Medicine' } }}
    />)
    let patient = result.$('[data-testid="patient-card-p1"]')
    assert.equal(patient?.getAttribute('data-priority'), 'high')
    assert.equal(patient?.querySelector('a')?.getAttribute('href'), patientHref)
    assert.ok(result.$('form[id="shift-s1-handover-form"]'))
    assert.equal(patient?.querySelectorAll('button[data-direction]').length, 0)
    assert.equal(patient?.querySelector('[aria-label="Open Patient A patient workspace"]')?.getAttribute('href'), patientHref)
    assert.equal(patient?.querySelector('[aria-label="Patient workspace"]'), null)
    assert.equal(patient?.querySelector('a[href^="/individual/new"]'), null)
    result.cleanup()
  })

  it('matches the digitised patient sheet with an empty handover log and pencil-edit table', async () => {
    let result = render(<PatientWorkspacePage
      patient={{ key: 'p1', displayName: 'Patient A', bed: 'Bed 4', handoverCount: 0, openTaskCount: 0, href: patientHref, handovers: [], processingHandovers: [] }}
      shift={{ id: 's1', title: 'Evening cover', department: 'Medicine', href: shiftHref }}
      createHandoverAction={createHandoverAction}
      session={{ user: { id: 'u1', fullName: 'Alex Morgan', occupation: 'Registrar', department: 'Medicine' } }}
      tabs={[{ key: 'sheet', label: 'Handover sheet', href: patientHref }, { key: 'actions', label: 'Actions', href: patientActionsHref }]}
      activeTab="sheet"
      sheetFields={[{ key: 'situation', label: 'Situation', value: 'Stable after review', confidence: 'low', status: 'pending', reviewAction: reviewPatientFieldAction, multiline: true }]}
      csrfToken="csrf"
    />)
    assert.equal(result.$(`a[href="${shiftHref}"]`)?.textContent?.trim(), 'Back to shift')
    assert.doesNotMatch(result.container.textContent ?? '', /Evening cover/)
    let receiving = result.$('button[data-direction="incoming"]')
    assert.equal(receiving?.textContent?.trim(), 'Receiving handover')
    assert.deepEqual(Array.from(result.$$('button[data-direction]')).map((button) => button.getAttribute('data-direction')), ['incoming', 'intra-shift', 'outgoing'])
    assert.equal(result.$('button[data-direction="intra-shift"]')?.textContent?.trim(), 'Intra-shift handover')
    assert.equal(result.$('button[data-direction="outgoing"]')?.textContent?.trim(), 'Delivering handover')
    assert.match(result.$('[data-testid="patient-handover-log"]')?.textContent ?? '', /digitised sheet row, but no verbal handover/)
    assert.ok((result.$('[data-testid="patient-handover-log"]')?.compareDocumentPosition(result.$('nav[aria-label="Patient workspace tabs"]')!) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING)
    assert.doesNotMatch(result.container.textContent ?? '', /\d+ handovers|\d+ open actions|communication events? linked to this patient/)
    assert.match(result.$('[data-testid="patient-sheet-table"]')?.textContent ?? '', /FieldCurrent value/)
    assert.equal(result.container.textContent?.includes('Review extracted details'), false)
    await result.act(() => result.$('button[aria-label="Edit Situation"]')?.click())
    let reviewForm = result.$('form[data-workflow="review-patient-sheet-field"]')
    assert.equal(reviewForm?.getAttribute('action'), reviewPatientFieldAction)
    assert.equal(reviewForm?.querySelector('input[name="_csrf"]')?.getAttribute('value'), 'csrf')
    assert.equal((reviewForm?.querySelector('[name="value"]') as HTMLTextAreaElement | null)?.value, 'Stable after review')
    await result.act(() => receiving?.click())
    let dialog = result.$('[data-testid="patient-handover-dialog"]')
    assert.equal(dialog?.tagName, 'DIALOG')
    assert.match(dialog?.textContent ?? '', /Start receiving handover/)
    assert.match(dialog?.textContent ?? '', /Patient-linked handover recording setup and consent controls/)
    assert.equal(dialog?.querySelector('form[data-workflow="create-handover"]')?.getAttribute('action'), createHandoverAction)
    assert.equal(dialog?.querySelector('input[name="shiftId"]')?.getAttribute('value'), 's1')
    assert.equal(dialog?.querySelector('input[name="linkedPatientKey"]')?.getAttribute('value'), 'p1')
    assert.equal(dialog?.querySelector('input[name="direction"]')?.getAttribute('value'), 'incoming')
    assert.equal(dialog?.querySelector('[data-analytics-id="handover-direction-select"]'), null)
    assert.ok(dialog?.querySelector('[data-analytics-id="handover-context-type-select"]'))
    assert.match(dialog?.textContent ?? '', /Shift to shift handover/)
    assert.equal((dialog?.querySelector('input[name="sourceDepartment"]') as HTMLInputElement | null)?.value, 'Medicine')
    assert.match(dialog?.textContent ?? '', /Manual transcript \(testing\)/)
    assert.match(dialog?.textContent ?? '', /Cancel/)
    result.cleanup()
  })

  it('keeps shift handover controls and complete action mutations on the patient actions route', async () => {
    let result = render(<PatientWorkspacePage
      patient={{
        key: 'p1', displayName: 'Patient A', bed: 'Bed 4', handoverCount: 2, openTaskCount: 1, href: patientHref,
        handovers: [
          { id: 'h1', title: 'Receiving handover', direction: 'incoming', status: 'completed', updatedAt: '2026-07-13T01:02:00.000Z', href: reviewHref({ shiftId: 's1', handoverId: 'h1', reviewTab: 'details' }) },
          { id: 'h3', title: 'Delivering handover', direction: 'outgoing', status: 'completed', updatedAt: '2026-07-13T03:04:00.000Z', href: reviewHref({ shiftId: 's1', handoverId: 'h3', reviewTab: 'details' }) },
        ],
        processingHandovers: [{ id: 'h2', title: 'Clinical update', direction: 'intra-shift', status: 'analysing', updatedAt: '2026-07-13T02:03:00.000Z', href: reviewHref({ shiftId: 's1', handoverId: 'h2', reviewTab: 'details' }) }],
      }}
      shift={{ id: 's1', title: 'Evening cover', department: 'Medicine', href: shiftHref }}
      createHandoverAction={createHandoverAction}
      session={{ user: { id: 'u1', fullName: 'Alex Morgan', occupation: 'Registrar', department: 'Medicine' } }}
      tabs={[{ key: 'sheet', label: 'Handover sheet', href: patientHref }, { key: 'actions', label: 'Actions', href: patientActionsHref }]}
      activeTab="actions"
      actions={[{ id: 't1', label: 'Review oxygen target', completed: false, due: '14 Jul 2026, 3:30 PM', dueAt: '2026-07-14T05:30:00.000Z', reminderEnabled: true, priority: 'urgent', handoverId: 'h1', handoverDirection: 'incoming', handoverUpdatedAt: '2026-07-13T01:02:00.000Z', updateAction: updateTaskAction, deleteAction: deleteTaskAction }]}
      createActionAction={createTaskAction}
      actionsHref={patientActionsHref}
      addActionHref={patientAddActionHref}
      csrfToken="csrf"
    />)
    assert.match(result.$('[data-testid="patient-handover-log"]')?.textContent ?? '', /Receiving handover/)
    assert.match(result.$('[data-testid="patient-handover-log"]')?.textContent ?? '', /Clinical update/)
    assert.ok((result.$('[data-testid="patient-handover-log"]')?.compareDocumentPosition(result.$('nav[aria-label="Patient workspace tabs"]')!) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING)
    assert.deepEqual(Array.from(result.$$('button[data-direction]')).map((button) => button.getAttribute('data-direction')), ['intra-shift'])
    let activeTab = result.$('nav[aria-label="Patient workspace tabs"] a[aria-current="page"]')
    assert.match(activeTab?.textContent ?? '', /^Actions1/)
    assert.equal(activeTab?.querySelector('[data-tab-meta]')?.textContent, '1')
    assert.equal(result.$('form[data-workflow="update-task-owner"]'), null)
    assert.equal(result.$('form[data-workflow="update-task-reminder"]')?.querySelector('[role="switch"]')?.getAttribute('aria-checked'), 'true')
    assert.equal(result.$('form[data-workflow="update-task-status"] input[name="status"]')?.getAttribute('value'), 'done')
    assert.equal(result.$(`a[href="${patientAddActionHref}"]`)?.textContent?.trim(), 'Add action')
    assert.equal(result.$('form[data-workflow="create-task"]'), null)
    assert.match(result.$('[data-testid="patient-task-row-t1"]')?.textContent ?? '', /Receiving/)
    assert.match(result.$('[data-testid="task-scope-filter"]')?.textContent ?? '', /ActionAll handovers/)
    let desktopHeader = result.$('[data-testid="task-desktop-header"]')
    assert.equal(desktopHeader?.children.length, 4)
    assert.equal(desktopHeader?.textContent?.includes('Owner'), false)
    let desktop = matchMedia('(min-width: 768px)').matches
    let taskRow = result.$('[data-testid="patient-task-row-t1"]')
    if (desktop) {
      let columns = computedStyle(desktopHeader).gridTemplateColumns.split(' ')
      assert.equal(columns.length, 4)
      assert.equal(columns[0], '320px')
      assert.equal(columns[3], '120px')
      assert.equal(computedStyle(taskRow).gridTemplateColumns, computedStyle(desktopHeader).gridTemplateColumns)
    }
    for (let id of ['task-reminder-filter', 'task-status-filter']) {
      let filter = result.$(`[data-testid="${id}"]`)!
      let parent = filter.parentElement!
      let parentStyle = computedStyle(parent)
      let availableWidth = parent.clientWidth - parseFloat(parentStyle.paddingLeft) - parseFloat(parentStyle.paddingRight)
      assert.ok(Math.abs(filter.getBoundingClientRect().width - availableWidth) < 1)
    }
    assert.equal(computedStyle(taskRow).borderRadius, desktop ? '0px' : '18px')
    assert.ok(result.$('[data-testid="task-mobile-filters"]'))
    assert.equal(result.$('[data-testid="task-owner-filter-mobile"]'), null)
    assert.match(result.$('[data-testid="patient-task-row-t1"]')?.textContent ?? '', /Keep this task visible for the next review./)
    assert.equal(computedStyle(result.$('[data-testid="task-toggle-t1"]')).height, desktop ? '32px' : '44px')

    await result.act(() => result.$('[data-testid="task-edit-t1"]')?.click())
    let editForm = result.$('form[data-workflow="edit-patient-task"]')
    assert.equal(editForm?.getAttribute('action'), updateTaskAction)
    assert.equal((editForm?.querySelector('input[name="label"]') as HTMLInputElement | null)?.value, 'Review oxygen target')
    assert.equal((editForm?.querySelector('input[name="dueLabel"]') as HTMLInputElement | null)?.value, '14 Jul 2026, 3:30 PM')
    assert.equal((editForm?.querySelector('input[name="dueAt"]') as HTMLInputElement | null)?.value, '2026-07-14T05:30:00.000Z')
    let duePicker = editForm?.querySelector('[data-testid="task-due-picker-t1"]') as HTMLButtonElement | null
    assert.equal(duePicker?.textContent?.trim(), '14 Jul 2026, 3:30 PM')
    assert.equal(duePicker?.getAttribute('aria-expanded'), 'false')
    await result.act(() => duePicker?.click())
    assert.equal(result.$('[data-testid="task-due-picker-t1"]')?.getAttribute('aria-expanded'), 'true')
    let dueDate = result.$('[data-testid="task-due-picker-t1-day-2026-07-14"]') as HTMLButtonElement
    let dueTime = result.$('#task-t1-due-at-time') as HTMLInputElement
    assert.equal(result.$('#task-t1-due-at-date'), null)
    assert.equal(computedStyle(result.$('[data-testid="task-due-picker-t1-calendar"]')).padding, '8px')
    assert.equal(dueDate.getAttribute('aria-selected'), 'true')
    assert.equal(dueTime.type, 'time')
    assert.equal(`2026-07-14T${dueTime.value}`, taskDueLocalValue('2026-07-14T05:30:00.000Z'))
    await result.act(() => result.$('[data-testid="task-due-picker-t1-day-2026-07-15"]')?.click())
    dueTime = result.$('#task-t1-due-at-time') as HTMLInputElement
    dueTime.value = '09:45'
    await result.act(() => dueTime.dispatchEvent(new Event('input', { bubbles: true })))
    await result.act(() => result.$('[data-testid="task-due-picker-t1"]')?.click())
    assert.equal(result.$('[data-testid="task-due-picker-t1"]')?.getAttribute('aria-expanded'), 'false')
    editForm = result.$('form[data-workflow="edit-patient-task"]')
    assert.equal((editForm?.querySelector('input[name="dueAt"]') as HTMLInputElement | null)?.value, new Date(2026, 6, 15, 9, 45).toISOString())
    assert.notEqual((editForm?.querySelector('input[name="dueLabel"]') as HTMLInputElement | null)?.value, 'No due date set')
    assert.equal(editForm?.querySelector('input[name="_intent"]')?.getAttribute('value'), 'details')
    assert.equal(editForm?.querySelector('input[name="handoverId"]'), null)
    assert.equal(editForm?.querySelector('input[name="priority"]'), null)
    assert.equal(editForm?.querySelector('input[name="source"]'), null)
    assert.equal(editForm?.querySelector('button[type="submit"]'), null)
    assert.match(editForm?.textContent ?? '', /Cancel.*Save action/)
    assert.equal(result.$('form[data-workflow="update-task-reminder"] input[name="_intent"]')?.getAttribute('value'), 'reminder')

    let editTitle = editForm?.querySelector('input[name="label"]') as HTMLInputElement
    await result.act(() => editTitle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    if (result.$('form[data-workflow="edit-patient-task"]')) throw new Error('Escape did not close the patient task editor')

    await result.act(() => result.$('[data-testid="task-delete-t1"]')?.click())
    let deleteDialog = result.$('[data-testid="task-delete-dialog"]')
    assert.equal(deleteDialog?.tagName, 'DIALOG')
    assert.match(deleteDialog?.textContent ?? '', /Delete "Review oxygen target" permanently/)
    assert.equal(deleteDialog?.querySelector('form[data-workflow="delete-patient-task"]')?.getAttribute('action'), deleteTaskAction)
    assert.equal(deleteDialog?.querySelector('input[name="_csrf"]')?.getAttribute('value'), 'csrf')
    await result.act(() => deleteDialog?.querySelector<HTMLButtonElement>('button[type="button"]')?.click())
    await result.act(() => Promise.resolve())
    if (result.$('[data-testid="task-delete-dialog"]')) throw new Error('Close did not remove the patient task dialog')

    await result.act(() => result.$('[data-testid="task-edit-t1"]')?.click())
    editForm = result.$('form[data-workflow="edit-patient-task"]')
    let submitCount = 0
    editForm?.addEventListener('submit', (event) => {
      event.preventDefault()
      submitCount += 1
    })
    let outsideTarget = result.$('[data-testid="task-delete-t1"]')
    await result.act(() => editForm?.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outsideTarget })))
    assert.equal(submitCount, 0)
    await result.act(() => editForm?.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outsideTarget })))
    assert.equal(submitCount, 0)
    let saveAction = Array.from(editForm?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) => button.textContent?.trim() === 'Save action')
    await result.act(() => saveAction?.click())
    assert.equal(submitCount, 1)
    result.cleanup()
  })

  it('keeps the empty Actions state free of duplicate handover controls', () => {
    let result = render(<PatientWorkspacePage
      patient={{ key: 'p1', displayName: 'Patient A', bed: 'Bed 4', handoverCount: 0, openTaskCount: 0, href: patientHref, handovers: [] }}
      shift={{ id: 's1', title: 'Evening cover', department: 'Medicine', href: shiftHref }}
      createHandoverAction={createHandoverAction}
      session={{ user: { id: 'u1', fullName: 'Alex Morgan', occupation: 'Registrar', department: 'Medicine' } }}
      tabs={[{ key: 'sheet', label: 'Handover sheet', href: patientHref }, { key: 'actions', label: 'Actions', href: patientActionsHref }]}
      activeTab="actions"
      actions={[]}
      csrfToken="csrf"
    />)

    assert.deepEqual(Array.from(result.$$('button[data-direction]')).map((button) => button.getAttribute('data-direction')), ['incoming', 'intra-shift', 'outgoing'])
    assert.equal(result.$('[data-testid="shift-patient-actions"] button[data-direction]'), null)
    assert.equal(result.$('[data-testid="shift-patient-actions"] a[href*="direction="]'), null)
    assert.match(result.$('[data-testid="shift-patient-actions"]')?.textContent ?? '', /Start a patient handover before adding actions/)
    assert.equal(result.$$('dialog[data-testid="patient-handover-dialog"]').length, 0)
    result.cleanup()
  })

  it('filters, sorts, and resets the patient action table without changing server data', async () => {
    let result = render(<PatientWorkspacePage
      patient={{ key: 'p1', displayName: 'Patient A', bed: 'Bed 4', handoverCount: 2, href: patientHref, handovers: [{ id: 'h1', title: 'Receiving handover', direction: 'incoming', status: 'completed', href: reviewHref({ shiftId: 's1', handoverId: 'h1', reviewTab: 'details' }) }] }}
      shift={{ id: 's1', title: 'Evening cover', department: 'Medicine', href: shiftHref }}
      tabs={[{ key: 'sheet', label: 'Handover sheet', href: patientHref }, { key: 'actions', label: 'Actions', href: patientActionsHref }]}
      activeTab="actions"
      actions={[
        { id: 't1', label: 'Review oxygen target', completed: false, reminderEnabled: false, handoverId: 'h1', handoverDirection: 'incoming', handoverUpdatedAt: '2026-07-13T01:02:00.000Z', updateAction: updateTaskAction },
        { id: 't2', label: 'Administer antibiotic', completed: true, reminderEnabled: true, handoverId: 'h1', handoverDirection: 'incoming', handoverUpdatedAt: '2026-07-13T01:02:00.000Z', updateAction: routes.actions.updateTask.href({ taskId: 't2' }) },
        { id: 't3', label: 'Book imaging', completed: false, reminderEnabled: true, handoverId: 'h2', handoverDirection: 'intra-shift', handoverUpdatedAt: '2026-07-13T02:03:00.000Z', updateAction: routes.actions.updateTask.href({ taskId: 't3' }) },
      ]}
      createActionAction={createTaskAction}
      actionsHref={patientActionsHref}
      addActionHref={patientAddActionHref}
      csrfToken="csrf"
    />)

    async function choose(testId: string, value: string) {
      let trigger = result.$(`[data-testid="${testId}"]`) as HTMLButtonElement
      await result.act(() => trigger.click())
      let option = trigger.parentElement?.querySelector<HTMLElement>(`[role="option"][data-select-value="${value}"]`)
      assert.ok(option)
      await result.act(async () => {
        option.click()
        await new Promise((resolve) => setTimeout(resolve, 600))
      })
    }

    await choose('task-sort', 'title-asc')
    let sortedRows = Array.from(result.$$('[data-testid^="patient-task-row-"]'), (row) => row.getAttribute('data-testid'))
    if (JSON.stringify(sortedRows) !== JSON.stringify(['patient-task-row-t2', 'patient-task-row-t3', 'patient-task-row-t1'])) throw new Error(`Sorted rows: ${JSON.stringify(sortedRows)}`)

    await result.act(() => result.$('[data-testid="task-reset-view"]')?.click())
    let resetRows = Array.from(result.$$('[data-testid^="patient-task-row-"]'), (row) => row.getAttribute('data-testid'))
    if (JSON.stringify(resetRows) !== JSON.stringify(['patient-task-row-t1', 'patient-task-row-t2', 'patient-task-row-t3'])) throw new Error(`Reset rows: ${JSON.stringify(resetRows)}`)
    let resetSort = result.$('[data-testid="task-sort"]') as HTMLButtonElement
    assert.equal(resetSort.getAttribute('data-value'), 'current')
    assert.match(resetSort.textContent ?? '', /Current order/)
    await result.act(() => resetSort.click())
    let selectedSortOption = resetSort.parentElement?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
    assert.equal(selectedSortOption?.getAttribute('data-select-value'), 'current')
    await result.act(() => resetSort.click())
    assert.equal(result.$('[data-testid="task-owner-filter"]'), null)

    await choose('task-scope-filter', 'handover:h2')
    let scopedRows = Array.from(result.$$('[data-testid^="patient-task-row-"]'), (row) => row.getAttribute('data-testid'))
    if (JSON.stringify(scopedRows) !== JSON.stringify(['patient-task-row-t3'])) throw new Error(`Scoped rows: ${JSON.stringify(scopedRows)}`)

    await result.act(() => result.$('[data-testid="task-reset-view"]')?.click())
    await choose('task-reminder-filter', 'on')
    let reminderRows = Array.from(result.$$('[data-testid^="patient-task-row-"]'), (row) => row.getAttribute('data-testid'))
    if (JSON.stringify(reminderRows) !== JSON.stringify(['patient-task-row-t2', 'patient-task-row-t3'])) throw new Error(`Reminder filter rows: ${JSON.stringify(reminderRows)}`)

    await choose('task-status-filter', 'done')
    let doneRows = Array.from(result.$$('[data-testid^="patient-task-row-"]'), (row) => row.getAttribute('data-testid'))
    if (JSON.stringify(doneRows) !== JSON.stringify(['patient-task-row-t2'])) throw new Error(`Done filter rows: ${JSON.stringify(doneRows)}`)
    result.cleanup()
  })

  it('uses the dedicated patient action composer route without losing shift context', async () => {
    let result = render(<PatientWorkspacePage
      patient={{ key: 'p1', displayName: 'Patient A', bed: 'Bed 4', handoverCount: 1, href: patientHref, handovers: [{ id: 'h1', title: 'Receiving handover', direction: 'incoming', status: 'completed', href: reviewHref({ shiftId: 's1', handoverId: 'h1', reviewTab: 'details' }) }] }}
      shift={{ id: 's1', title: 'Evening cover', department: 'Medicine', href: shiftHref }}
      createHandoverAction={createHandoverAction}
      session={{ user: { id: 'u1', fullName: 'Alex Morgan', occupation: 'Registrar', department: 'Medicine' } }}
      tabs={[{ key: 'sheet', label: 'Handover sheet', href: patientHref }, { key: 'actions', label: 'Actions', href: patientActionsHref }]}
      activeTab="actions"
      actionRoute="add"
      actionsHref={patientActionsHref}
      addActionHref={patientAddActionHref}
      createActionAction={createTaskAction}
      csrfToken="csrf"
    />)
    let createForm = result.$('form[data-workflow="create-task"]')
    assert.equal(createForm?.getAttribute('action'), createTaskAction)
    assert.equal(createForm?.querySelector('input[name="patientKey"]')?.getAttribute('value'), 'p1')
    assert.equal((createForm?.querySelector('input[name="reminderEnabled"]') as HTMLInputElement | null)?.value, 'false')
    assert.equal(createForm?.querySelector('[role="switch"]')?.getAttribute('aria-checked'), 'false')
    assert.equal((createForm?.querySelector('input[name="dueAt"]') as HTMLInputElement | null)?.value, '')
    assert.equal((createForm?.querySelector('input[name="dueLabel"]') as HTMLInputElement | null)?.value, 'No due date set')
    let addAction = createForm?.querySelector<HTMLButtonElement>('button[type="submit"]')!
    assert.equal(addAction.disabled, true)
    let actionTitle = createForm?.querySelector<HTMLInputElement>('input[name="label"]')!
    actionTitle.value = 'Arrange community review'
    await result.act(() => actionTitle.dispatchEvent(new Event('input', { bubbles: true })))
    createForm = result.$('form[data-workflow="create-task"]')
    assert.equal(createForm?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled, false)
    await result.act(() => createForm?.querySelector<HTMLButtonElement>('[role="switch"]')?.click())
    assert.equal(createForm?.querySelector('[role="switch"]')?.getAttribute('aria-checked'), 'true')
    assert.equal((createForm?.querySelector('input[name="reminderEnabled"]') as HTMLInputElement | null)?.value, 'true')
    let duePicker = createForm?.querySelector('[data-testid="new-task-due-picker"]') as HTMLButtonElement
    assert.equal(duePicker.textContent?.trim(), 'No due date set')
    await result.act(() => duePicker.click())
    let month = result.$('[data-testid="new-task-due-picker-calendar"] select[aria-label="Choose month"]') as HTMLSelectElement
    month.value = '6'
    await result.act(() => month.dispatchEvent(new Event('change', { bubbles: true })))
    let year = result.$('[data-testid="new-task-due-picker-calendar"] select[aria-label="Choose year"]') as HTMLSelectElement
    year.value = '2026'
    await result.act(() => year.dispatchEvent(new Event('change', { bubbles: true })))
    await result.act(() => result.$('[data-testid="new-task-due-picker-day-2026-07-14"]')?.click())
    let dueTime = result.$('#new-task-due-at-time') as HTMLInputElement
    dueTime.value = '15:30'
    await result.act(() => dueTime.dispatchEvent(new Event('input', { bubbles: true })))
    createForm = result.$('form[data-workflow="create-task"]')
    assert.equal((createForm?.querySelector('input[name="dueAt"]') as HTMLInputElement | null)?.value, new Date(2026, 6, 14, 15, 30).toISOString())
    assert.notEqual((createForm?.querySelector('input[name="dueLabel"]') as HTMLInputElement | null)?.value, 'No due date set')
    assert.equal(createForm?.querySelector(`a[href="${patientActionsHref}"]`)?.textContent?.trim(), 'Cancel')
    result.cleanup()
  })
})
