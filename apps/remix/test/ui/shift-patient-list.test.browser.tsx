import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { render } from 'remix/component/test'

import { ShiftPatientList } from '../../app/assets/shift-patient-list.tsx'
import { routes } from '../../app/routes.ts'
import { computedStyle, resolvedColor } from './styles.ts'

const shift = {
  id: 'shift-1',
  title: 'Evening cover',
  department: 'Medicine',
  href: routes.workspace.shift.href({ shiftId: 'shift-1' }),
}
const orderAction = routes.actions.orderPatients.href({ shiftId: shift.id })
const patients = [
  {
    key: 'patient-1', displayName: 'Molly Harper', bed: '3A-01', priority: 'high' as const,
    href: routes.workspace.patient.href({ shiftId: shift.id, patientKey: 'patient-1' }),
    editAction: routes.actions.updateShiftPatient.href({ shiftId: shift.id, patientKey: 'patient-1' }),
    editableHandoverId: 'handover-1',
  },
  {
    key: 'patient-2', displayName: 'Arthur Dent', bed: '3A-02', priority: 'routine' as const,
    href: routes.workspace.patient.href({ shiftId: shift.id, patientKey: 'patient-2' }),
    editAction: routes.actions.updateShiftPatient.href({ shiftId: shift.id, patientKey: 'patient-2' }),
  },
]

describe('shift patient card parity', () => {
  it('closes an unchanged patient editor without sending a redundant mutation', async () => {
    let originalFetch = window.fetch
    let requests = 0
    window.fetch = async () => { requests++; return new Response(null, { status: 204 }) }
    let result = render(<ShiftPatientList patients={patients} csrfToken="csrf-token" />)

    try {
      await result.act(() => result.$('[data-testid="patient-card-patient-1"] button[aria-label="Edit patient details"]')?.click())
      let form = result.$('form[data-workflow="edit-shift-patient-details"]') as HTMLFormElement

      await result.act(async () => {
        form.requestSubmit()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      assert.equal(requests, 0)
      assert.equal(result.$('form[data-workflow="edit-shift-patient-details"]'), null)
      assert.equal(result.$('[role="alert"]'), null)
      assert.match(result.$('[data-testid="patient-card-patient-1"]')?.textContent ?? '', /Molly Harper/)
    } finally {
      result.cleanup()
      window.fetch = originalFetch
    }
  })

  it('edits Name and Location inline with focus, Enter, Escape, and visible pending controls', async () => {
    let result = render(<ShiftPatientList patients={patients} orderAction={orderAction} csrfToken="csrf-token" />)
    let card = result.$('[data-testid="patient-card-patient-1"]')
    let grip = card?.querySelector<HTMLElement>('[title="Drag to reprioritise"]')
    assert.equal(computedStyle(grip).cursor, 'grab')
    assert.equal(computedStyle(card).borderRadius, '22px')
    assert.equal(computedStyle(card).borderTopColor, resolvedColor('color-mix(in oklab, white 70%, transparent)'))
    assert.equal(computedStyle(card).backgroundColor, resolvedColor('color-mix(in oklab, white 92%, transparent)'))
    let workspaceLink = card?.querySelector<HTMLAnchorElement>('[aria-label="Open Molly Harper patient workspace"]')
    assert.equal(workspaceLink?.getAttribute('href'), patients[0]!.href)
    assert.equal(computedStyle(workspaceLink).minHeight, '48px')
    await result.act(() => workspaceLink?.focus())
    assert.equal(document.activeElement, workspaceLink)
    // Keyboard focus exposes the same visible navigation feedback as hover.
    for (let animation of workspaceLink?.getAnimations() ?? []) animation.finish()
    assert.equal(computedStyle(workspaceLink).backgroundColor, resolvedColor('color-mix(in oklab, var(--primary) 8%, transparent)'))
    assert.equal(card?.querySelector('[aria-label="Patient workspace"]'), null)
    let wideLayout = window.matchMedia('(min-width: 40rem)').matches
    let cardLayout = computedStyle(card?.querySelector(':scope > div > div'))
    assert.equal(cardLayout.flexDirection, wideLayout ? 'row' : 'column')
    if (wideLayout) assert.equal(cardLayout.alignItems, 'center')
    let editButton = card?.querySelector('button[aria-label="Edit patient details"]')
    assert.equal(computedStyle(editButton).width, '44px')
    assert.equal(computedStyle(editButton).height, '44px')
    for (let reorderButton of card?.querySelectorAll<HTMLButtonElement>('form button[type="submit"]') ?? []) {
      assert.equal(computedStyle(reorderButton).width, '44px')
      assert.equal(computedStyle(reorderButton).height, '44px')
    }
    assert.equal(computedStyle(grip).width, '44px')
    assert.equal(computedStyle(grip).height, '44px')

    await result.act(() => card?.querySelector<HTMLButtonElement>('button[aria-label="Edit patient details"]')?.click())
    await result.act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

    let form = result.$('form[data-workflow="edit-shift-patient-details"]')
    assert.equal(form?.getAttribute('action'), patients[0]!.editAction)
    assert.equal(form?.querySelector('input[name="_csrf"]')?.getAttribute('value'), 'csrf-token')
    assert.equal(form?.querySelector('input[name="handoverId"]')?.getAttribute('value'), 'handover-1')
    assert.equal((document.activeElement as HTMLElement | null)?.getAttribute('aria-label'), 'Name')
    assert.match(form?.textContent ?? '', /Save details/)
    assert.match(form?.textContent ?? '', /Cancel/)
    assert.equal(computedStyle(form?.querySelector('input[name="location"]')).height, '44px')
    for (let action of form?.querySelectorAll<HTMLButtonElement>('button') ?? []) {
      assert.equal(computedStyle(action).height, '44px')
    }

    let location = form?.querySelector<HTMLInputElement>('input[name="location"]')
    location?.focus()
    if (location) {
      location.value = 'Ward 4'
      await result.act(() => location.dispatchEvent(new Event('input', { bubbles: true })))
    }
    assert.equal((document.activeElement as HTMLElement | null)?.getAttribute('aria-label'), 'Location')

    form = result.$('form[data-workflow="edit-shift-patient-details"]')
    let submissions = 0
    form?.addEventListener('submit', (event) => {
      submissions++
      event.preventDefault()
    })
    let name = form?.querySelector<HTMLInputElement>('input[name="displayName"]')
    name?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await result.act(() => {})
    assert.equal(submissions, 1)
    assert.match(result.$('form[data-workflow="edit-shift-patient-details"]')?.textContent ?? '', /Saving details/)
    result.cleanup()

    result = render(<ShiftPatientList patients={patients} />)
    await result.act(() => result.$('[data-testid="patient-card-patient-1"] button[aria-label="Edit patient details"]')?.click())
    let editor = result.$('input[aria-label="Name"]')
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await result.act(() => {})
    assert.equal(result.$('form[data-workflow="edit-shift-patient-details"]'), null)
    assert.match(result.$('[data-testid="patient-card-patient-1"]')?.textContent ?? '', /Molly Harper/)
    result.cleanup()
  })

  it('uses a card-only pointer preview and submits the dropped patient order through a CSRF form', async () => {
    let result = render(<ShiftPatientList patients={patients} orderAction={orderAction} csrfToken="csrf-token" />)
    let first = result.$('[data-testid="patient-card-patient-1"]') as HTMLLIElement
    let second = result.$('[data-testid="patient-card-patient-2"]') as HTMLLIElement
    first.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 480, bottom: 160, width: 480, height: 160, toJSON() {} })
    let originalElementFromPoint = document.elementFromPoint.bind(document)
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => second })

    let orderForm = result.$('form[data-workflow="reorder-shift-patients"]') as HTMLFormElement
    let submissions = 0
    orderForm.addEventListener('submit', (event) => {
      submissions++
      event.preventDefault()
    })

    try {
      first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 12, clientY: 12, pointerId: 1 }))
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 32, clientY: 36, pointerId: 1 }))
      await result.act(() => {})

      let preview = document.body.querySelector<HTMLElement>('[data-drag-preview="shift-patient-card"]')
      assert.ok(preview)
      assert.equal(preview?.getAttribute('aria-hidden'), 'true')
      assert.equal(preview?.style.position, 'fixed')
      assert.equal(preview?.style.pointerEvents, 'none')
      assert.equal(result.$('[data-testid="patient-card-patient-1"]')?.getAttribute('data-dragging'), 'true')
      let dropTarget = result.$('[data-testid="patient-card-patient-2"]')
      for (let animation of dropTarget?.getAnimations() ?? []) animation.finish()
      assert.equal(computedStyle(dropTarget).borderTopColor, resolvedColor('color-mix(in oklab, var(--primary) 20%, transparent)'))
      assert.equal(computedStyle(dropTarget).backgroundColor, resolvedColor('color-mix(in oklab, white 92%, transparent)'))
      assert.equal(computedStyle(dropTarget).boxShadow, 'rgba(74, 110, 224, 0.12) 0px 14px 32px 0px')

      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 32, clientY: 36, pointerId: 1 }))
      await result.act(() => {})

      assert.equal(submissions, 1)
      assert.equal((orderForm.querySelector('input[name="_csrf"]') as HTMLInputElement | null)?.value, 'csrf-token')
      assert.equal((orderForm.querySelector('input[name="patientKeys"]') as HTMLInputElement | null)?.value, '["patient-2","patient-1"]')
      assert.equal(result.$('ol[aria-label="Patients in priority order"] > li')?.getAttribute('data-patient-key'), 'patient-2')
      assert.equal(document.body.querySelector('[data-drag-preview="shift-patient-card"]'), null)
    } finally {
      Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: originalElementFromPoint })
      result.cleanup()
    }
  })
})
