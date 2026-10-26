/*
 * Checkbox presentation adapted from @remix-run/ui 0.8.0.
 *
 * MIT License
 *
 * Copyright (c) 2025 Shopify Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { clientEntry, css, on, type Handle, type SerializableProps } from 'remix/component'

import {
  frameMutationRequestHeader,
  frameMutationRequestValue,
} from '../utils/frame-mutation.ts'
import { refreshFrameAfterMutation } from './frame-mutation.ts'

type ChecklistItem = {
  id: string
  label: string
  checked?: boolean
  status?: 'addressed' | 'partial' | 'missing'
  detail?: string
}

interface ChecklistProps extends SerializableProps {
  items: ChecklistItem[]
  action?: string
  csrfToken?: string
  disabled?: boolean
  withHeader?: boolean
}

const sections = [
  { key: 'introduction', label: 'Introduction' },
  { key: 'situation', label: 'Situation' },
  { key: 'background', label: 'Background' },
  { key: 'assessment', label: 'Assessment' },
  { key: 'recommendation', label: 'Recommendation' },
] as const

const checkedCheckboxSelector = '&:checked, &[aria-checked="true"], &[data-state="checked"]'
const greenCheckedCheckbox = {
  background: '#059669',
  boxShadow: '0 0 0 1px #059669, 0 2px 6px rgba(5, 150, 105, 0.24)',
}
const checklistCheckboxBase = {
  appearance: 'none',
  WebkitAppearance: 'none',
  margin: 0,
  boxSizing: 'border-box',
  position: 'relative',
  display: 'inline-grid',
  placeItems: 'center',
  width: '1rem',
  height: '1rem',
  minWidth: '1rem',
  minHeight: '1rem',
  padding: 0,
  border: 0,
  borderRadius: '4px',
  background: 'light-dark(#ffffff, #1a1a1a)',
  color: 'light-dark(#ffffff, #151515)',
  verticalAlign: 'middle',
  flex: 'none',
  '&::before': {
    content: '""',
    position: 'absolute',
    opacity: 0,
    pointerEvents: 'none',
    left: '50%',
    top: '50%',
    width: '12px',
    height: '12px',
    background: 'currentColor',
    mask: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 12 12\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cpath d=\'M2.75 5.76562L5.10156 8.25L9.23438 1.75\' fill=\'none\' stroke=\'black\' stroke-width=\'1.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E") center / contain no-repeat',
    transform: 'translate(-50%, calc(-50% + 1px))',
  },
  '&:checked': { borderRadius: '5px' },
  '&:checked::before': { opacity: 1 },
  '&:disabled': { cursor: 'not-allowed', opacity: 0.55 },
  '&:focus-visible': {
    outline: '2px solid var(--ring)',
    outlineOffset: '3px',
  },
} satisfies Parameters<typeof css>[0]
const checklistCheckboxStyle = {
  covered: css({
    ...checklistCheckboxBase,
    boxShadow: '0 0 0 1px rgba(5, 150, 105, 0.35)',
    [checkedCheckboxSelector]: greenCheckedCheckbox,
  }),
  optional: css({
    ...checklistCheckboxBase,
    boxShadow: '0 0 0 1px rgba(217, 119, 6, 0.35)',
    [checkedCheckboxSelector]: greenCheckedCheckbox,
  }),
  mandatory: css({
    ...checklistCheckboxBase,
    boxShadow: '0 0 0 1px rgba(225, 29, 72, 0.35)',
    [checkedCheckboxSelector]: greenCheckedCheckbox,
  }),
} as const

const mandatoryLabels = new Set([
  'id_check',
  'bg_history',
  'bg_allergies',
  'assess_obs',
  'assess_medications',
  'rec_plan',
  'rec_patient_goals',
])

export const ChecklistEditor = clientEntry(import.meta.url + '#ChecklistEditor', function ChecklistEditor(handle: Handle<ChecklistProps>) {
  let statuses = checklistStatuses(handle.props.items)
  let appliedServerStatuses = new Map(statuses)
  let pendingStatuses = new Map<string, ChecklistStatus>()
  let saving = false
  let saveError = ''

  // Remix's browser HMR transform retains setup declarations before the render return.
  function reconcileServerStatuses() {
    let currentIds = new Set(handle.props.items.map((item) => item.id))
    for (let item of handle.props.items) {
      let serverStatus = checklistStatus(item)
      let pendingStatus = pendingStatuses.get(item.id)
      if (pendingStatus) {
        // A Frame refresh may arrive while the POST is in flight. Preserve the
        // optimistic choice until the server reflects that exact value.
        if (serverStatus === pendingStatus) {
          statuses.set(item.id, serverStatus)
          appliedServerStatuses.set(item.id, serverStatus)
          pendingStatuses.delete(item.id)
        }
        continue
      }
      // Compare the authoritative Frame value with the actual local value.
      // The applied-server marker may still equal an older prop after an
      // optimistic mutation, so it must never suppress this reconciliation.
      if (statuses.get(item.id) !== serverStatus) statuses.set(item.id, serverStatus)
      appliedServerStatuses.set(item.id, serverStatus)
    }

    for (let id of appliedServerStatuses.keys()) {
      if (currentIds.has(id) || pendingStatuses.has(id)) continue
      appliedServerStatuses.delete(id)
      statuses.delete(id)
    }
  }

  return () => {
    reconcileServerStatuses()
    let covered = new Set(handle.props.items.filter((item) => statuses.get(item.id) === 'addressed').map((item) => item.id))
    let sectionGroups = sections.map((section) => {
      let items = handle.props.items.filter((item) => sectionKey(item.label) === section.key)
      return { ...section, items, coveredCount: items.filter((item) => covered.has(item.id)).length }
    }).filter((section) => section.items.length)
    let mandatoryMissing = handle.props.items.filter((item) => !covered.has(item.id) && isMandatory(item, handle.props.items, covered)).length
    let optionalMissing = handle.props.items.length - covered.size - mandatoryMissing
    let coverageSummary = <div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem", fontSize: "0.875rem", lineHeight: "1.42857143", color: "var(--color-slate-500)" })}>
        <span>{covered.size} of {handle.props.items.length} items covered</span>
        <CoverageBadge tone="covered">{`Covered ${covered.size}`}</CoverageBadge>
        {optionalMissing > 0 ? <CoverageBadge tone="optional">{`Optional not covered ${optionalMissing}`}</CoverageBadge> : null}
        {mandatoryMissing > 0 ? <CoverageBadge tone="mandatory">{`Mandatory not covered ${mandatoryMissing}`}</CoverageBadge> : null}
      </div>

    return <div mix={css({ display: "grid", gap: "1rem" })} data-testid="checklist-editor" data-disabled={handle.props.disabled || undefined} aria-busy={saving || undefined} aria-disabled={handle.props.disabled || undefined}>
      {handle.props.withHeader ? <header mix={css({ display: "grid", gridAutoRows: "min-content", alignItems: "flex-start", gap: "0.25rem", paddingInline: "1rem" })}><h2 mix={css({ fontFamily: "'Geist Variable', sans-serif", fontSize: "1rem", lineHeight: "1.375", fontWeight: "500" })}>Checklist coverage</h2>{coverageSummary}</header> : coverageSummary}
      <div mix={css({
        display: 'grid',
        gap: '1rem',
        ...(handle.props.withHeader ? {
          paddingInline: '1rem'
        } : {})
      })}>
      {sectionGroups.map((section) => <section key={section.key} mix={css({
        overflow: 'hidden',
        borderRadius: '22px',
        borderStyle: 'solid',
        borderWidth: '1px',
        borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
        backgroundColor: 'var(--color-white)',
        transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
        transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
        transitionDuration: '150ms',
        ...(handle.props.disabled ? {
          opacity: '65%',
          filter: 'saturate(50%)'
        } : {})
      })}>
        <div mix={css({
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          borderBottomStyle: 'solid',
          borderBottomWidth: '1px',
          borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
          backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 70%, transparent)',
          paddingInline: '1rem',
          paddingBlock: '0.75rem'
        })}>
          <div>
            <h3 mix={css({ fontFamily: "'Geist Variable', sans-serif", fontSize: "1rem", lineHeight: "1.5", fontWeight: "500", color: "var(--color-slate-950)" })}>{section.label}</h3>
            <div mix={css({ fontSize: "0.75rem", lineHeight: "1.33333333", color: "var(--color-slate-500)" })}>{section.coveredCount} of {section.items.length} covered</div>
          </div>
          <span mix={css({
            display: 'inline-flex',
            height: '1.25rem',
            width: 'fit-content',
            flexShrink: '0',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'calc(infinity * 1px)',
            backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 6%, transparent)',
            paddingInline: '0.5rem',
            paddingBlock: '0.125rem',
            fontSize: '0.75rem',
            lineHeight: '1.33333333',
            fontWeight: '500',
            whiteSpace: 'nowrap',
            color: 'var(--color-slate-700)',
            boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-950) 10%, transparent)'
          })}>{section.items.length} items</span>
        </div>

        <div mix={css({
          ':where(& > :not(:last-child))': {
            borderBottomStyle: 'solid',
            borderTopStyle: 'solid',
            borderTopWidth: '0px',
            borderBottomWidth: '1px',
            borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)'
          }
        })}>
          {section.items.map((item) => {
            let isCovered = covered.has(item.id)
            let mandatory = isMandatory(item, handle.props.items, covered)
            let tone: keyof typeof checklistCheckboxStyle = isCovered ? 'covered' : mandatory ? 'mandatory' : 'optional'
            let itemIndex = handle.props.items.findIndex((candidate) => candidate.id === item.id)
            let itemLabelId = `${handle.id}-checklist-item-${itemIndex}-label`
            let itemStatusId = `${handle.id}-checklist-item-${itemIndex}-status`
            return <form method="post" action={handle.props.action} data-workflow="update-checklist" key={item.id} data-covered={isCovered || undefined} data-checklist-item-label={item.label} aria-disabled={handle.props.disabled || undefined} mix={css({
              display: 'flex',
              alignItems: 'flex-start',
              gap: '0.75rem',
              paddingInline: '1rem',
              paddingBlock: '1rem',
              ...(handle.props.disabled ? {
                cursor: 'not-allowed'
              } : {}),
              ...(tone === 'covered' ? {
                borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                backgroundColor: 'var(--color-white)'
              } : tone === 'mandatory' ? {
                borderColor: 'color-mix(in oklab, var(--color-rose-200) 70%, transparent)',
                backgroundColor: 'color-mix(in oklab, var(--color-rose-50) 45%, transparent)'
              } : {
                borderColor: 'color-mix(in oklab, var(--color-amber-200) 70%, transparent)',
                backgroundColor: 'color-mix(in oklab, var(--color-amber-50) 45%, transparent)'
              })
            })}>
              {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
              <input type="hidden" name="checklistItemId" value={item.id} />
              <span mix={css({ paddingTop: "0.25rem" })}>
                <input type="checkbox" name="covered" value="true" checked={isCovered} disabled={saving || handle.props.disabled} aria-checked={isCovered} data-state={isCovered ? 'checked' : 'unchecked'} aria-labelledby={itemLabelId} aria-describedby={itemStatusId} data-testid={`checklist-toggle-${item.id}`} mix={[checklistCheckboxStyle[tone], on('change', async (event) => {
                  if (handle.props.disabled) return
                  let previousStatus = statuses.get(item.id) ?? 'missing'
                  let nextStatus: ChecklistStatus
                  if (event.currentTarget.checked) {
                    nextStatus = 'addressed'
                  } else {
                    nextStatus = 'missing'
                  }
                  statuses.set(item.id, nextStatus)
                  pendingStatuses.set(item.id, nextStatus)
                  saveError = ''
                  if (!handle.props.action) {
                    pendingStatuses.delete(item.id)
                    await handle.update()
                    return
                  }
                  let form = event.currentTarget.closest('form')
                  if (!form) {
                    await handle.update()
                    return
                  }

                  // Snapshot the reviewed checklist before the pending render
                  // reconciles the checkbox and hidden field.
                  let body = new FormData(form)
                  body.set('covered', event.currentTarget.checked ? 'true' : 'false')
                  saving = true
                  await handle.update()
                  let response: Response
                  try {
                    response = await fetch(form.action, {
                      method: form.method || 'post',
                      body,
                      credentials: 'same-origin',
                      headers: {
                        accept: 'text/html',
                        [frameMutationRequestHeader]: frameMutationRequestValue,
                      },
                      signal: handle.signal,
                    })
                    if (handle.signal.aborted) return
                    if (!response.ok) throw new Error(`Checklist save failed (${response.status})`)
                  } catch (error) {
                    if (handle.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
                    pendingStatuses.delete(item.id)
                    statuses.set(item.id, previousStatus)
                    saving = false
                    saveError = 'The checklist change could not be saved. Your previous selection has been restored.'
                    await handle.update()
                    return
                  }

                  let refreshed = true
                  try {
                    await refreshFrameAfterMutation(handle.frame, response, form.action)
                  } catch (error) {
                    if (handle.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
                    refreshed = false
                    saveError = 'The checklist was saved, but the page could not be refreshed.'
                  }
                  // Keep the optimistic value protected until the Frame reload
                  // has had a chance to deliver the committed server state.
                  // If reload failed, retaining the local value is preferable
                  // to reverting a mutation the server already accepted.
                  if (refreshed) pendingStatuses.delete(item.id)
                  saving = false
                  await handle.update()
                })]} />
                <noscript><button type="submit" mix={css({ marginLeft: "0.5rem", fontSize: "0.75rem", lineHeight: "1.33333333", textDecorationLine: "underline" })}>Save</button></noscript>
              </span>
              <span mix={css({ minWidth: "0rem", flex: "1" })}>
                <span id={itemStatusId} mix={css({
                  display: 'inline-flex',
                  alignItems: 'center',
                  borderRadius: 'calc(infinity * 1px)',
                  paddingInline: '0.625rem',
                  paddingBlock: '0.25rem',
                  fontSize: '11px',
                  fontWeight: '600',
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  ...(tone === 'covered' ? {
                    backgroundColor: 'color-mix(in oklab, var(--color-emerald-500) 8%, transparent)',
                    color: 'var(--color-emerald-900)',
                    boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-emerald-500) 10%, transparent)'
                  } : tone === 'mandatory' ? {
                    backgroundColor: 'color-mix(in oklab, var(--color-rose-500) 8%, transparent)',
                    color: 'var(--color-rose-900)',
                    boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-rose-500) 12%, transparent)'
                  } : {
                    backgroundColor: 'color-mix(in oklab, var(--color-amber-500) 9%, transparent)',
                    color: 'var(--color-amber-900)',
                    boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-amber-500) 15%, transparent)'
                  })
                })}>
                  {tone === 'covered' ? 'Covered' : tone === 'mandatory' ? 'Mandatory not covered' : 'Optional not covered'}
                </span>
                <span id={itemLabelId} mix={css({
                  marginTop: '0.5rem',
                  display: 'block',
                  fontSize: '0.875rem',
                  lineHeight: '1.5rem',
                  ...(tone === 'mandatory' ? {
                    color: 'color-mix(in oklab, var(--color-rose-950) 85%, transparent)'
                  } : tone === 'optional' ? {
                    color: 'color-mix(in oklab, var(--color-amber-950) 85%, transparent)'
                  } : {
                    color: 'var(--color-slate-700)'
                  })
                })}>{item.detail || humanize(item.label)}</span>
              </span>
              <span data-checklist-status-icon={tone} mix={css({
                marginTop: '0.125rem',
                display: 'flex',
                width: '2.25rem',
                height: '2.25rem',
                flexShrink: '0',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 'calc(infinity * 1px)',
                ...(tone === 'covered' ? {
                  backgroundColor: 'color-mix(in oklab, var(--color-emerald-500) 8%, transparent)',
                  color: 'var(--color-emerald-700)',
                  boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-emerald-500) 10%, transparent)'
                } : tone === 'mandatory' ? {
                  backgroundColor: 'color-mix(in oklab, var(--color-rose-500) 8%, transparent)',
                  color: 'var(--color-rose-700)',
                  boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-rose-500) 12%, transparent)'
                } : {
                  backgroundColor: 'color-mix(in oklab, var(--color-amber-500) 9%, transparent)',
                  color: 'var(--color-amber-700)',
                  boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-amber-500) 15%, transparent)'
                })
              })} aria-hidden="true">
                {tone === 'covered' ? <CheckCheckIcon /> : tone === 'mandatory' ? <AlertIcon /> : <InfoIcon />}
              </span>
            </form>
          })}
        </div>
      </section>)}
      {saving ? <span mix={css({
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: '0',
        margin: '-1px',
        overflow: 'hidden',
        clipPath: 'inset(50%)',
        whiteSpace: 'nowrap',
        borderWidth: '0'
      })} data-visually-hidden="" role="status">Saving checklist change…</span> : null}
      {saveError ? <div role="alert" mix={css({
        borderRadius: '14px',
        borderStyle: 'solid',
        borderWidth: '1px',
        borderColor: 'var(--color-rose-200)',
        backgroundColor: 'var(--color-rose-50)',
        paddingInline: '0.75rem',
        paddingBlock: '0.5rem',
        fontSize: '0.875rem',
        lineHeight: '1.5rem',
        color: 'var(--color-rose-900)'
      })}>{saveError}</div> : null}
      </div>
    </div>
  }
})

type ChecklistStatus = 'addressed' | 'partial' | 'missing'

function checklistStatus(item: ChecklistItem): ChecklistStatus {
  return item.checked ? 'addressed' : item.status ?? 'missing'
}

function checklistStatuses(items: ChecklistItem[]) {
  return new Map(items.map((item) => [item.id, checklistStatus(item)]))
}

function CoverageBadge(handle: Handle<{ tone: 'covered' | 'optional' | 'mandatory'; children?: string | number }>) {
  return () => <span mix={css({
    display: 'inline-flex',
    height: '1.25rem',
    width: 'fit-content',
    flexShrink: '0',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'calc(infinity * 1px)',
    paddingInline: '0.5rem',
    paddingBlock: '0.125rem',
    fontSize: '0.75rem',
    lineHeight: '1.33333333',
    fontWeight: '500',
    whiteSpace: 'nowrap',
    ...(handle.props.tone === 'covered' ? {
      backgroundColor: 'color-mix(in oklab, var(--color-emerald-500) 8%, transparent)',
      color: 'var(--color-emerald-900)',
      boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-emerald-500) 10%, transparent)'
    } : handle.props.tone === 'mandatory' ? {
      backgroundColor: 'color-mix(in oklab, var(--color-rose-500) 8%, transparent)',
      color: 'var(--color-rose-900)',
      boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-rose-500) 15%, transparent)'
    } : {
      backgroundColor: 'color-mix(in oklab, var(--color-amber-500) 9%, transparent)',
      color: 'var(--color-amber-900)',
      boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-amber-500) 15%, transparent)'
    })
  })}>{handle.props.children}</span>
}

function sectionKey(label: string) {
  if (label.startsWith('introduction_') || label === 'invitation' || label === 'id_check') return 'introduction'
  if (label.startsWith('sit_')) return 'situation'
  if (label.startsWith('bg_')) return 'background'
  if (label.startsWith('assess_')) return 'assessment'
  return 'recommendation'
}

function isMandatory(item: ChecklistItem, items: ChecklistItem[], covered: Set<string>) {
  if (item.label.startsWith('sit_')) return !items.some((candidate) => candidate.label.startsWith('sit_') && covered.has(candidate.id))
  return mandatoryLabels.has(item.label)
}

function humanize(value: string) {
  return value.replace(/^(introduction|sit|bg|assess|rec)_/, '').replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())
}

function CheckCheckIcon() { return () => <svg data-icon="check-check" mix={css({ width: "1rem", height: "1rem" })} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 7 17l-5-5" /><path d="m22 10-7.5 7.5L13 16" /></svg> }
function AlertIcon() { return () => <svg mix={css({ width: "1rem", height: "1rem" })} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg> }
function InfoIcon() { return () => <svg mix={css({ width: "1rem", height: "1rem" })} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg> }
