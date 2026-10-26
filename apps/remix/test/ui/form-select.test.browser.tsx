import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { render } from 'remix/component/test'

import { InboxPlacementForm } from '../../app/assets/inbox-placement-form.tsx'
import { NewHandoverForm } from '../../app/assets/new-handover-form.tsx'
import { Option, Select } from '../../app/assets/form-select.tsx'
import { routes } from '../../app/routes.ts'
import { computedStyle } from './styles.ts'

describe('handover form selects', () => {
  it('commits keyboard choices to the composer and restores trigger focus on Escape', async () => {
    let result = render(<NewHandoverForm action={routes.actions.createHandover.href()} mode="individual" presentation="inline" />)
    try {
      let form = result.$('form[data-workflow="create-handover"]') as HTMLFormElement
      let trigger = result.$('[data-analytics-id="handover-context-type-select"]') as HTMLButtonElement
      assert.equal(new FormData(form).get('contextType'), 'short-transfer')
      assert.equal(computedStyle(trigger).height, '32px')
      assert.equal(trigger.getAttribute('aria-haspopup'), 'listbox')

      await result.act(() => {
        trigger.focus()
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      })
      let list = result.$('[role="listbox"]') as HTMLElement
      assert.equal(trigger.getAttribute('aria-expanded'), 'true')
      await result.act(() => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })))
      await result.act(async () => {
        list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        await new Promise((resolve) => setTimeout(resolve, 500))
      })
      assert.equal(new FormData(form).get('contextType'), 'community-transfer')
      assert.equal(trigger.textContent?.trim(), 'Inpatient to community transfer')
      assert.match((form.querySelector('input[name="title"]') as HTMLInputElement).value, /Inpatient to community transfer/)

      await result.act(() => trigger.click())
      await result.act(() => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
      assert.equal(trigger.getAttribute('aria-expanded'), 'false')
      assert.equal(document.activeElement, trigger)
      assert.equal(new FormData(form).get('contextType'), 'community-transfer')
    } finally {
      result.cleanup()
    }
  })

  it('submits the selected receiving shift from the inbox placement dialog', async () => {
    let result = render(<InboxPlacementForm
      action={routes.actions.placeAssignment.href({ assignmentId: 'a1' })}
      assignmentTitle="Patient handover"
      assignedBy="Casey Bennett"
      sourceLabel="Ward A"
      shifts={[
        { id: 'day', title: 'Day', department: 'Medicine' },
        { id: 'night', title: 'Night', department: 'Surgery' },
      ]}
    />)
    try {
      await result.act(() => result.$('button[aria-haspopup="dialog"]')?.click())
      let form = result.$('form[data-workflow="place-handover"]') as HTMLFormElement
      let trigger = form.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement
      assert.equal(new FormData(form).get('shiftId'), 'day')
      await result.act(() => trigger.click())
      let option = [...form.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes('Night'))
      assert.ok(option)
      await result.act(async () => {
        option.click()
        await new Promise((resolve) => setTimeout(resolve, 500))
      })
      assert.equal(new FormData(form).get('shiftId'), 'night')
      assert.equal(trigger.textContent?.trim(), 'Night · Surgery')
      assert.equal(trigger.getAttribute('aria-expanded'), 'false')
    } finally {
      result.cleanup()
    }
  })

  it('excludes a disabled select from form submission', () => {
    let result = render(<form>
      <Select name="shiftId" defaultValue="day" defaultLabel="Day" disabled>
        <Option value="day" label="Day" />
      </Select>
    </form>)
    try {
      assert.equal((result.$('button') as HTMLButtonElement).disabled, true)
      assert.equal(new FormData(result.$('form') as HTMLFormElement).has('shiftId'), false)
    } finally {
      result.cleanup()
    }
  })
})
