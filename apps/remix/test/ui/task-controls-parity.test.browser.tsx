import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { TypedEventTarget, type FrameHandle } from 'remix/component'
import { render } from 'remix/component/test'

import { PatientActionsPanel } from '../../app/assets/patient-actions-panel.tsx'
import { routes } from '../../app/routes.ts'
import {
  frameMutationLocationHeader,
  frameMutationRequestHeader,
  frameMutationRequestValue,
} from '../../app/utils/frame-mutation.ts'
import { computedStyle } from './styles.ts'

function taskAction(taskId: string) {
  return routes.actions.updateTask.href({ taskId })
}

describe('task control parity', () => {
  it('updates reminders through the Remix frame without navigating or resetting scroll', async () => {
    let reloads = 0
    let navigations = 0
    let scrolls = 0
    let requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    let persistedReminder = true
    let result: ReturnType<typeof render>
    let panel = () => <PatientActionsPanel
      csrfToken="csrf-token"
      patientOptions={[{ key: 'p1', label: 'Patient A · Bed 4' }]}
      tasks={[{
        id: 't1',
        label: 'Review oxygen target',
        completed: false,
        reminderEnabled: persistedReminder,
        updateAction: taskAction('t1'),
      }]}
    />
    let frame = Object.assign(new TypedEventTarget<{ reloadStart: Event; reloadComplete: Event }>(), {
      $runtime: {},
      src: `${window.location.origin}/tasks`,
      async reload() {
        reloads++
        result.root.render(panel())
        result.root.flush()
        return new AbortController().signal
      },
      async replace() {},
    }) as FrameHandle
    let originalFetch = window.fetch
    let originalScrollTo = window.scrollTo
    let onNavigate = () => { navigations++ }
    window.navigation.addEventListener('navigate', onNavigate)
    window.scrollTo = () => { scrolls++ }
    window.fetch = async (input, init) => {
      requests.push({ input, init })
      await new Promise((resolve) => setTimeout(resolve, 10))
      if (init?.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError')
      let body = init?.body
      assert.ok(body instanceof FormData)
      persistedReminder = body.get('reminderEnabled') === 'true'
      return new Response(null, {
        status: 204,
        headers: { [frameMutationLocationHeader]: '/tasks' },
      })
    }

    result = render(panel(), { frame })

    try {
      await result.act(async () => {
        ;(result.$('[data-testid="task-reminder-form-t1"] [role="switch"]') as HTMLButtonElement | null)?.click()
        await new Promise((resolve) => setTimeout(resolve, 25))
      })

      let first = requests[0]
      assert.ok(first)
      assert.ok(String(first.input).endsWith(taskAction('t1')))
      assert.equal(first.init?.method, 'post')
      assert.equal(first.init?.credentials, 'same-origin')
      assert.equal(new Headers(first.init?.headers).get(frameMutationRequestHeader), frameMutationRequestValue)
      assert.ok(first.init?.signal instanceof AbortSignal)
      assert.ok(first.init?.body instanceof FormData)
      assert.equal(first.init.body.get('_csrf'), 'csrf-token')
      assert.equal(first.init.body.get('_intent'), 'reminder')
      assert.equal(first.init.body.get('reminderEnabled'), 'false')
      assert.equal(reloads, 1)
      assert.equal(navigations, 0)
      assert.equal(scrolls, 0)
      assert.equal(result.$('[data-testid="task-reminder-form-t1"] [role="switch"]')?.getAttribute('aria-checked'), 'false')
      assert.equal((result.$('[data-testid="task-reminder-form-t1"] [role="switch"]') as HTMLButtonElement | null)?.disabled, false)

      await result.act(async () => {
        ;(result.$('[data-testid="task-reminder-form-t1"] [role="switch"]') as HTMLButtonElement | null)?.click()
        await new Promise((resolve) => setTimeout(resolve, 25))
      })

      let second = requests[1]
      assert.ok(second?.init?.body instanceof FormData)
      assert.equal(second.init.body.get('reminderEnabled'), 'true')
      assert.equal(persistedReminder, true)
      assert.equal(reloads, 2)
      assert.equal(navigations, 0)
      assert.equal(scrolls, 0)
      assert.equal(result.$('[data-testid="task-reminder-form-t1"] [role="switch"]')?.getAttribute('aria-checked'), 'true')
      assert.equal((result.$('[data-testid="task-reminder-form-t1"] [role="switch"]') as HTMLButtonElement | null)?.disabled, false)
    } finally {
      result.cleanup()
      window.fetch = originalFetch
      window.scrollTo = originalScrollTo
      window.navigation.removeEventListener('navigate', onNavigate)
    }
  })

  it('keeps the reminder form in place and rolls back its optimistic state when the POST fails', async () => {
    let reloads = 0
    let requests = 0
    let frame = Object.assign(new TypedEventTarget<{ reloadStart: Event; reloadComplete: Event }>(), {
      $runtime: {},
      src: 'http://localhost/tasks',
      async reload() {
        reloads++
        return new AbortController().signal
      },
      async replace() {},
    }) as FrameHandle
    let originalFetch = window.fetch
    window.fetch = async () => {
      requests++
      return new Response('Task reminder is invalid.', { status: 400 })
    }
    let result = render(<PatientActionsPanel
      csrfToken="csrf-token"
      patientOptions={[{ key: 'p1', label: 'Patient A · Bed 4' }]}
      tasks={[{
        id: 't1',
        label: 'Review oxygen target',
        completed: false,
        reminderEnabled: false,
        updateAction: taskAction('t1'),
      }]}
    />, { frame })

    try {
      await result.act(async () => {
        ;(result.$('[data-testid="task-reminder-form-t1"] [role="switch"]') as HTMLButtonElement | null)?.click()
        await new Promise((resolve) => setTimeout(resolve, 25))
      })

      assert.equal(requests, 1)
      assert.equal(reloads, 0)
      assert.equal(result.$('[role="alert"]')?.textContent, 'Task reminder is invalid.')
      assert.equal(result.$('[data-testid="task-reminder-form-t1"] [role="switch"]')?.getAttribute('aria-checked'), 'false')
      assert.equal((result.$('[data-testid="task-reminder-form-t1"] [role="switch"]') as HTMLButtonElement | null)?.disabled, false)
    } finally {
      result.cleanup()
      window.fetch = originalFetch
    }
  })

  it('keeps an unsaved action draft active until it is explicitly saved or cancelled', async () => {
    let result = render(<PatientActionsPanel
      patientOptions={[{ key: 'p1', label: 'Patient A · Bed 4' }]}
      tasks={[
        { id: 't1', label: 'Review oxygen target', completed: false, reminderEnabled: true, updateAction: taskAction('t1'), deleteAction: routes.actions.deleteTask.href({ taskId: 't1' }) },
        { id: 't2', label: 'Administer antibiotic', completed: false, reminderEnabled: false, updateAction: taskAction('t2'), deleteAction: routes.actions.deleteTask.href({ taskId: 't2' }) },
      ]}
    />)

    await result.act(() => result.$('[data-testid="task-edit-t1"]')?.click())
    let label = result.$('#task-t1-label') as HTMLInputElement
    label.value = 'Review oxygen target before lunch'
    await result.act(() => label.dispatchEvent(new Event('input', { bubbles: true })))

    let secondEdit = result.$('[data-testid="task-edit-t2"]') as HTMLButtonElement
    assert.equal(secondEdit.getAttribute('aria-disabled'), 'true')
    assert.equal(secondEdit.getAttribute('aria-describedby'), 'task-t1-editing-hint')
    for (let taskId of ['t1', 't2']) {
      assert.equal((result.$(`[data-testid="task-reminder-form-${taskId}"] [role="switch"]`) as HTMLButtonElement).disabled, true)
      assert.equal((result.$(`[data-testid="task-toggle-${taskId}"]`) as HTMLButtonElement).disabled, true)
      assert.equal((result.$(`[data-testid="task-delete-${taskId}"]`) as HTMLButtonElement).disabled, true)
    }

    await result.act(() => secondEdit.click())

    label = result.$('#task-t1-label') as HTMLInputElement
    assert.equal(label.value, 'Review oxygen target before lunch')
    assert.equal(document.activeElement, label)
    assert.ok(result.$('[data-testid="task-edit-form-t1"]'))
    assert.equal(result.$('[data-testid="task-edit-form-t2"]'), null)

    await result.act(() => {
      let cancel = Array.from(result.$$('button')).find((button) => button.textContent === 'Cancel')
      cancel?.click()
    })

    secondEdit = result.$('[data-testid="task-edit-t2"]') as HTMLButtonElement
    assert.equal(secondEdit.getAttribute('aria-disabled'), null)
    assert.equal((result.$('[data-testid="task-reminder-form-t2"] [role="switch"]') as HTMLButtonElement).disabled, false)
    assert.equal((result.$('[data-testid="task-toggle-t2"]') as HTMLButtonElement).disabled, false)
    assert.equal((result.$('[data-testid="task-delete-t2"]') as HTMLButtonElement).disabled, false)
    await result.act(() => secondEdit.click())
    assert.ok(result.$('[data-testid="task-edit-form-t2"]'))
    result.cleanup()
  })

  it('uses the React-style calendar grid while preserving concrete due values', async () => {
    let result = render(<PatientActionsPanel
      patientOptions={[{ key: 'p1', label: 'Patient A · Bed 4' }]}
      tasks={[{
        id: 't1',
        label: 'Review oxygen target',
        completed: false,
        dueAt: '2026-07-14T05:30:00.000Z',
        updateAction: taskAction('t1'),
      }]}
    />)

    await result.act(() => result.$('[data-testid="task-edit-t1"]')?.click())
    let popover = result.$('[data-testid="task-due-picker-t1-popover"]')
    assert.ok(popover)
    assert.equal(computedStyle(popover).display, 'none')
    await result.act(() => result.$('[data-testid="task-due-picker-t1"]')?.click())

    popover = result.$('[data-testid="task-due-picker-t1-popover"]')
    assert.ok(popover)
    assert.equal(popover.matches(':popover-open'), true)
    assert.equal(computedStyle(popover).display, 'flex')
    assert.ok(popover.querySelector('[role="grid"]'))
    assert.equal(popover.querySelector('input[type="date"]'), null)
    assert.equal(popover.querySelector('button')?.getAttribute('aria-label'), 'Go to previous month')
    let selectedDay = popover.querySelector<HTMLButtonElement>('[data-testid="task-due-picker-t1-day-2026-07-14"]')
    assert.equal(selectedDay?.getAttribute('aria-selected'), 'true')
    assert.equal(selectedDay?.tabIndex, 0)
    assert.equal(popover.querySelectorAll('[role="gridcell"][tabindex="0"]').length, 1)
    assert.equal(popover.querySelectorAll('[role="gridcell"]').length, 42)
    assert.equal((popover.querySelector('select[aria-label="Choose month"]') as HTMLSelectElement | null)?.value, '6')
    assert.equal((popover.querySelector('select[aria-label="Choose year"]') as HTMLSelectElement | null)?.value, '2026')

    let month = popover.querySelector('select[aria-label="Choose month"]') as HTMLSelectElement
    month.focus()
    month.value = '7'
    await result.act(() => month.dispatchEvent(new Event('change', { bubbles: true })))
    assert.equal(popover.querySelector('select[aria-label="Choose month"]'), month)
    assert.equal(month.value, '7')
    assert.equal(document.activeElement, month)

    let year = popover.querySelector('select[aria-label="Choose year"]') as HTMLSelectElement
    year.focus()
    year.value = '2027'
    await result.act(() => year.dispatchEvent(new Event('change', { bubbles: true })))
    assert.equal(popover.querySelector('select[aria-label="Choose year"]'), year)
    assert.equal(year.value, '2027')
    assert.equal(document.activeElement, year)

    let visibleDay = result.$('[data-testid="task-due-picker-t1-day-2027-08-14"]') as HTMLButtonElement
    assert.equal(visibleDay.tabIndex, 0)

    await result.act(() => visibleDay.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
    let nextDay = result.$('[data-testid="task-due-picker-t1-day-2027-08-15"]') as HTMLButtonElement
    assert.equal(nextDay.tabIndex, 0)
    assert.equal(document.activeElement, nextDay)

    await result.act(() => nextDay.click())
    let time = result.$('#task-t1-due-at-time') as HTMLInputElement
    time.value = '09:45'
    await result.act(() => time.dispatchEvent(new Event('input', { bubbles: true })))

    let form = result.$('form[data-workflow="edit-patient-task"]')
    assert.equal((form?.querySelector('input[name="dueAt"]') as HTMLInputElement | null)?.value, new Date(2027, 7, 15, 9, 45).toISOString())
    assert.doesNotMatch(popover.textContent ?? '', /Clear|Done/)
    result.cleanup()
  })

  it('closes an open date-time popover before Remix navigation and frame reloads replace its anchor', async () => {
    let frame = Object.assign(new TypedEventTarget<{ reloadStart: Event; reloadComplete: Event }>(), {
      $runtime: {},
      src: 'http://localhost/tasks',
      async reload() { return new AbortController().signal },
      async replace() {},
    }) as FrameHandle
    let result = render(<PatientActionsPanel
      patientOptions={[{ key: 'p1', label: 'Patient A · Bed 4' }]}
      tasks={[{
        id: 't1',
        label: 'Review oxygen target',
        completed: false,
        dueAt: '2026-07-14T05:30:00.000Z',
        updateAction: taskAction('t1'),
      }]}
    />, { frame })

    await result.act(() => result.$('[data-testid="task-edit-t1"]')?.click())
    let trigger = result.$('[data-testid="task-due-picker-t1"]') as HTMLButtonElement
    let popover = result.$('[data-testid="task-due-picker-t1-popover"]') as HTMLElement
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')
    assert.equal(popover.matches(':popover-open'), false)

    // A reconciled native popover can remain in the browser top layer even
    // though the new component instance starts with local `open = false`.
    popover.showPopover()
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')
    assert.equal(popover.matches(':popover-open'), true)

    await result.act(() => window.navigation.dispatchEvent(new Event('navigate')))
    trigger = result.$('[data-testid="task-due-picker-t1"]') as HTMLButtonElement
    popover = result.$('[data-testid="task-due-picker-t1-popover"]') as HTMLElement
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')
    assert.equal(popover.matches(':popover-open'), false)

    await result.act(() => trigger.click())
    trigger = result.$('[data-testid="task-due-picker-t1"]') as HTMLButtonElement
    popover = result.$('[data-testid="task-due-picker-t1-popover"]') as HTMLElement
    assert.equal(trigger.getAttribute('aria-expanded'), 'true')
    assert.equal(popover.matches(':popover-open'), true)

    await result.act(() => window.navigation.dispatchEvent(new Event('navigate')))
    trigger = result.$('[data-testid="task-due-picker-t1"]') as HTMLButtonElement
    popover = result.$('[data-testid="task-due-picker-t1-popover"]') as HTMLElement
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')
    assert.equal(popover.matches(':popover-open'), false)

    await result.act(() => trigger.click())
    trigger = result.$('[data-testid="task-due-picker-t1"]') as HTMLButtonElement
    popover = result.$('[data-testid="task-due-picker-t1-popover"]') as HTMLElement
    assert.equal(popover.matches(':popover-open'), true)

    await result.act(() => frame.dispatchEvent(new Event('reloadStart')))
    trigger = result.$('[data-testid="task-due-picker-t1"]') as HTMLButtonElement
    popover = result.$('[data-testid="task-due-picker-t1-popover"]') as HTMLElement
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')
    assert.equal(popover.matches(':popover-open'), false)
    result.cleanup()
  })

  it('uses Remix listbox popovers with the React pill trigger and menu geometry', async () => {
    let result = render(<PatientActionsPanel
      patientOptions={[{ key: 'p1', label: 'Patient A · Bed 4' }]}
      tasks={[
        { id: 't1', label: 'Review oxygen target', completed: false, updateAction: taskAction('t1') },
        { id: 't2', label: 'Administer antibiotic', completed: true, updateAction: taskAction('t2') },
      ]}
    />)

    let trigger = result.$('[data-testid="task-sort"]') as HTMLButtonElement
    assert.equal(trigger.tagName, 'BUTTON')
    assert.equal(trigger.getAttribute('aria-haspopup'), 'listbox')
    assert.equal(computedStyle(trigger).height, window.matchMedia('(min-width: 48rem)').matches ? '32px' : '44px')
    assert.ok(Number.parseFloat(computedStyle(trigger).borderRadius) >= trigger.getBoundingClientRect().height / 2)
    assert.match(trigger.textContent ?? '', /SortCurrent order/)

    await result.act(() => trigger.click())
    let list = result.$('[role="listbox"]')
    let option = result.$('[role="option"][data-select-value="title-asc"]')
    assert.ok(list)
    assert.ok(option)
    assert.equal(computedStyle(option).borderRadius, '8px')
    assert.equal(computedStyle(option).paddingRight, '32px')
    assert.equal(computedStyle(option).paddingLeft, '6px')

    await result.act(() => option.click())
    await new Promise((resolve) => setTimeout(resolve, 300))
    await result.act(() => {})
    assert.equal(result.$('[data-testid="task-sort"]')?.getAttribute('data-value'), 'title-asc')
    assert.deepEqual(Array.from(result.$$('[data-testid^="patient-task-row-"]'), (row) => row.getAttribute('data-testid')), ['patient-task-row-t2', 'patient-task-row-t1'])
    result.cleanup()
  })
})
