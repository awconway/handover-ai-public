import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { render } from 'remix/component/test'

import { DeleteShiftForm } from '../../app/assets/delete-shift-form.tsx'
import { NewShiftForm } from '../../app/assets/new-shift-form.tsx'
import { ShiftSheetUpload } from '../../app/assets/shift-sheet-upload.tsx'
import { routes } from '../../app/routes.ts'

describe('shift workflow control parity', () => {
  it('preserves invalid shift values and focuses the first field-level error', async () => {
    let result = render(<NewShiftForm
      action={routes.actions.createShift.href()}
      defaultTitle=""
      defaultDepartment=""
    />)
    let form = result.$('form[data-workflow="start-shift"]') as HTMLFormElement
    let title = form.querySelector<HTMLInputElement>('input[name="title"]')!
    let department = form.querySelector<HTMLInputElement>('input[name="department"]')!

    await result.act(() => {
      title.value = 'X'
      title.dispatchEvent(new InputEvent('input', { bubbles: true }))
      department.value = 'Y'
      department.dispatchEvent(new InputEvent('input', { bubbles: true }))
    })
    await result.act(() => form.requestSubmit())

    title = result.$('input[name="title"]') as HTMLInputElement
    department = result.$('input[name="department"]') as HTMLInputElement
    assert.equal(title.value, 'X')
    assert.equal(department.value, 'Y')
    assert.equal(title.getAttribute('aria-invalid'), 'true')
    assert.equal(department.getAttribute('aria-invalid'), 'true')
    assert.match(result.$('#shift-title-error')?.textContent ?? '', /at least 3 characters/)
    assert.match(result.$('#shift-department-error')?.textContent ?? '', /at least 2 characters/)
    assert.equal(document.activeElement, title)
    assert.equal((result.$('button[type="submit"]') as HTMLButtonElement).disabled, false)
    result.cleanup()
  })

  it('preserves the native shift POST and shows the React starting state', async () => {
    let result = render(<NewShiftForm
      action={routes.actions.createShift.href()}
      assignedUserId="user-1"
      csrfToken="csrf-token"
      defaultDepartment="Medicine"
    />)
    let form = result.$('form[data-workflow="start-shift"]') as HTMLFormElement
    let title = form.querySelector<HTMLInputElement>('input[name="title"]')
    let department = form.querySelector<HTMLInputElement>('input[name="department"]')
    let notes = form.querySelector<HTMLTextAreaElement>('textarea[name="notes"]')
    await result.act(async () => {
      if (title) {
        title.value = 'Night shift'
        title.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Night shift' }))
      }
      await Promise.resolve()
    })
    assert.equal(title?.value, 'Night shift')
    await result.act(async () => {
      if (department) {
        department.value = 'Acute Medicine'
        department.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Acute Medicine' }))
      }
      await Promise.resolve()
    })
    assert.equal(department?.value, 'Acute Medicine')
    await result.act(async () => {
      if (notes) {
        notes.value = 'Cover wards 3 and 4'
        notes.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Cover wards 3 and 4' }))
      }
      await Promise.resolve()
    })
    assert.equal(notes?.value, 'Cover wards 3 and 4')
    result.root.render(<NewShiftForm
      action={routes.actions.createShift.href()}
      assignedUserId="user-1"
      csrfToken="csrf-token"
      defaultDepartment="Medicine"
    />)
    result.root.flush()
    form = result.$('form[data-workflow="start-shift"]') as HTMLFormElement
    form.addEventListener('submit', (event) => event.preventDefault())

    await result.act(() => form.requestSubmit())

    let button = result.$('button[type="submit"]') as HTMLButtonElement
    assert.equal(form.action.endsWith(routes.actions.createShift.href()), true)
    assert.equal(form.querySelector('input[name="_csrf"]')?.getAttribute('value'), 'csrf-token')
    assert.equal(form.querySelector('input[name="assignedUserIds"]')?.getAttribute('value'), '["user-1"]')
    assert.equal((form.querySelector('input[name="title"]') as HTMLInputElement).value, 'Night shift')
    assert.equal((form.querySelector('input[name="department"]') as HTMLInputElement).value, 'Acute Medicine')
    assert.equal((form.querySelector('textarea[name="notes"]') as HTMLTextAreaElement).value, 'Cover wards 3 and 4')
    assert.equal(button.disabled, true)
    assert.match(button.textContent ?? '', /Starting shift/)
    assert.ok(button.querySelector('[role="status"][aria-label="Loading"]'))
    result.cleanup()
  })

  it('matches the shared React sheet import pending affordance', async () => {
    let result = render(<ShiftSheetUpload action={routes.actions.importHandoverSheet.href({ shiftId: 'shift-1' })} csrfToken="csrf-token" />)
    let forms = Array.from(document.querySelectorAll<HTMLFormElement>('form'))
    forms[0]?.addEventListener('submit', (event) => event.preventDefault())

    await result.act(() => forms[0]?.requestSubmit())

    let buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    assert.equal(buttons.length, 2)
    assert.equal(buttons[0]?.disabled, true)
    assert.equal(buttons[1]?.disabled, true)
    assert.match(buttons[0]?.textContent ?? '', /Importing/)
    assert.match(buttons[1]?.textContent ?? '', /Choose file/)
    assert.equal(buttons[1]?.textContent?.includes('Reading sheet'), false)
    assert.ok(buttons[0]?.querySelector('[role="status"][aria-label="Loading"]'))
    result.cleanup()
  })

  it('keeps delete as an ordinary POST and locks the native dialog while deleting', async () => {
    let deleteAction = routes.actions.deleteShift.href({ shiftId: 'shift-1' })
    let result = render(<DeleteShiftForm action={deleteAction} shiftTitle="Day shift" csrfToken="csrf-token" />)

    await result.act(() => result.$('button[aria-haspopup="dialog"]')?.click())

    let dialog = result.$('dialog') as HTMLDialogElement
    let form = dialog.querySelector('form') as HTMLFormElement
    form.addEventListener('submit', (event) => event.preventDefault())
    await result.act(() => form.requestSubmit())

    let confirm = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')
    let cancel = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Cancel')
    assert.equal(form.action.endsWith(deleteAction), true)
    assert.equal(form.querySelector('input[name="_csrf"]')?.getAttribute('value'), 'csrf-token')
    assert.equal(dialog.getAttribute('aria-busy'), 'true')
    assert.equal(confirm?.disabled, true)
    assert.equal(confirm?.textContent, 'Deleting')
    assert.equal(cancel?.disabled, true)
    assert.equal(dialog.querySelector('button[aria-label="Close"]'), null)
    result.cleanup()
  })
})
