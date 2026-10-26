import { css, clientEntry, link, on, type Handle, type SerializableProps } from 'remix/component'

import { enhanceFrameMutation } from './frame-mutation.ts'

type ReviewEvent = {
  at: string
  byUserId: string
  previousValue: string
  nextValue: string
  method: 'human' | 'llm' | 'automatic'
}

type SbarUpdateEvent = {
  at: string
  handoverId: string
  handoverTitle: string
  sbarSection: 'situation' | 'background' | 'assessment' | 'recommendation'
  previousValue: string
  nextValue: string
  summaryQuote: string
  rationale: string
  sourceHref?: string
}

interface PatientSheetFieldProps extends SerializableProps {
  fieldKey: string
  label: string
  value?: string
  editValue?: string
  hasCapturedValue?: boolean
  reviewStatus?: 'automatic' | 'needs_review' | 'human_verified' | 'llm_adjudicated'
  alternatives?: string[]
  reviewEvents?: ReviewEvent[]
  sbarUpdateEvents?: SbarUpdateEvent[]
  action?: string
  csrfToken?: string
}

type EditEvent =
  | { kind: 'review'; event: ReviewEvent }
  | { kind: 'sbar'; event: SbarUpdateEvent }

/** A native field-review island; every mutation remains an ordinary Remix form POST. */
export const PatientSheetField = clientEntry(import.meta.url + '#PatientSheetField', function PatientSheetField(handle: Handle<PatientSheetFieldProps>) {
  let editing = false
  let value = editableValue(handle.props)
  let saving = false
  let saveError = ''

  return () => {
    let displayValue = handle.props.value || `${handle.props.label} not captured`
    let editEvents = getEditEvents(handle.props)

    return <div
      data-testid={`patient-sheet-field-${handle.props.fieldKey}`}
      mix={css({
        display: 'grid',
        gap: '0.5rem',
        paddingInline: '1rem',
        paddingBlock: '1rem',
        '@media (width >= 48rem)': {
          gridTemplateColumns: 'minmax(9rem,0.75fr) minmax(0,1.8fr) 3rem',
          alignItems: 'flex-start'
        }
      })}
    >
      <div data-field-label mix={css({
        fontSize: '11px',
        fontWeight: '600',
        letterSpacing: '0.16em',
        color: 'var(--color-slate-500)',
        textTransform: 'uppercase',
        '@media (width >= 48rem)': {
          fontSize: '0.875rem',
          lineHeight: '1.42857143',
          letterSpacing: '0em',
          color: 'var(--color-slate-700)',
          textTransform: 'none'
        }
      })}>{handle.props.label}</div>

      {editing && handle.props.action ? <>
        <div mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", overflowWrap: "break-word", color: "var(--color-slate-800)" })}>
          <form method="post" action={handle.props.action}  data-workflow="review-patient-sheet-field" aria-busy={saving || undefined} mix={[css({ display: "grid", gap: "0.5rem" }), enhanceFrameMutation(handle, {
            onPending(value) { saving = value; if (value) saveError = '' },
            onError(message) { saveError = message },
            onRefreshError() { saveError = 'The review was saved, but the sheet could not be refreshed.' },
            onSuccess() { editing = false; saveError = '' },
          })]}>
            {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
            <input type="hidden" name="fieldKey" value={handle.props.fieldKey} />
            <input type="hidden" name="decision" value="edited" />
            <textarea
              name="value"
              aria-label={`${handle.props.label} reviewed value`}
              value={value}
              mix={[css({
                display: 'flex',
                fieldSizing: 'content',
                minHeight: '6rem',
                width: '100%',
                borderRadius: '16px',
                borderStyle: 'solid',
                borderWidth: '1px',
                borderColor: 'var(--color-slate-200)',
                backgroundColor: 'var(--color-white)',
                paddingInline: '0.625rem',
                paddingBlock: '0.5rem',
                fontSize: '0.875rem',
                lineHeight: '1.5rem',
                color: 'var(--color-slate-900)',
                boxShadow: 'none',
                transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
                transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                transitionDuration: '150ms',
                outlineStyle: 'none',
                '&:focus-visible': {
                  borderColor: 'var(--ring)',
                  boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
                }
              }), on('input', (event) => {
                value = (event.currentTarget as HTMLTextAreaElement).value
                handle.update()
              })]}
            ></textarea>
            <div mix={css({ display: "flex", flexWrap: "wrap", gap: "0.5rem" })}>
              <button type="submit" disabled={saving} mix={css(primaryButtonStyles)}><CheckIcon />{saving ? 'Saving review' : 'Save review'}</button>
              <button type="button" disabled={saving} mix={[css(outlineButtonStyles), on('click', () => {
                value = editableValue(handle.props)
                editing = false
                handle.update()
              })]}>Cancel</button>
            </div>
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
          </form>
          {handle.props.reviewStatus === 'needs_review' && handle.props.alternatives?.length ? <div mix={css({
            marginTop: '0.5rem',
            ':where(& > :not(:last-child))': {
              marginBlockStart: '0px',
              marginBlockEnd: '0.25rem'
            },
            borderRadius: 'calc(var(--radius) * 0.8)',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'color-mix(in oklab, var(--color-amber-200) 70%, transparent)',
            backgroundColor: 'color-mix(in oklab, var(--color-amber-50) 70%, transparent)',
            paddingInline: '0.75rem',
            paddingBlock: '0.5rem',
            fontSize: '0.75rem',
            lineHeight: '1.25rem',
            color: 'var(--color-amber-900)'
          })}>
            <div mix={css({ fontWeight: "600" })}>Model alternatives</div>
            {handle.props.alternatives.slice(0, 3).map((alternative) => <div key={alternative} mix={css({ whiteSpace: "pre-wrap" })}>{alternative}</div>)}
          </div> : null}
        </div>
        <div />
      </> : <>
        <div mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", overflowWrap: "break-word", color: "var(--color-slate-800)" })}>
          <div mix={css({ whiteSpace: "pre-wrap" })}>{displayValue}</div>
          {editEvents.length ? <details mix={css({
            marginTop: '0.75rem',
            borderRadius: '14px',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
            backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 75%, transparent)'
          })}>
            <summary mix={css({
              display: 'flex',
              cursor: 'pointer',
              listStyleType: 'none',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.75rem',
              paddingInline: '0.75rem',
              paddingBlock: '0.5rem',
              fontSize: '0.75rem',
              lineHeight: '1.33333333',
              fontWeight: '500',
              color: 'var(--color-slate-700)'
            })}>
              <span>View version history</span>
              <span mix={css({
                display: 'inline-flex',
                minWidth: '1.25rem',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 'calc(infinity * 1px)',
                backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 6%, transparent)',
                paddingInline: '0.375rem',
                paddingBlock: '0.125rem',
                fontSize: '11px',
                color: 'var(--color-slate-600)',
                boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-950) 10%, transparent)'
              })}>{editEvents.length}</span>
            </summary>
            <ol mix={css({
              ':where(& > :not(:last-child))': {
                marginBlockStart: '0px',
                marginBlockEnd: '0.75rem'
              },
              borderTopStyle: 'solid',
              borderTopWidth: '1px',
              borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
              padding: '0.75rem'
            })}>
              {[...editEvents].reverse().map((event, index) => <li key={`${eventIdentity(event)}:${index}`} mix={css({ borderRadius: "12px", backgroundColor: "color-mix(in oklab, var(--color-white) 85%, transparent)", padding: "0.75rem" })}>
                <div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" })}>
                  <div mix={css({ fontSize: "10px", fontWeight: "600", letterSpacing: "0.14em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Before edit · {formatVersionTimestamp(event.event.at)}</div>
                  {event.kind === 'sbar' && event.event.sourceHref ? <a
                    href={event.event.sourceHref}
                    mix={[css({
                      display: 'inline-flex',
                      width: 'fit-content',
                      alignItems: 'center',
                      gap: '0.375rem',
                      borderRadius: 'calc(infinity * 1px)',
                      borderStyle: 'solid',
                      borderWidth: '1px',
                      borderColor: 'var(--color-slate-200)',
                      backgroundColor: 'var(--color-white)',
                      paddingInline: '0.625rem',
                      paddingBlock: '0.25rem',
                      fontSize: '0.75rem',
                      lineHeight: '1.33333333',
                      fontWeight: '500',
                      color: 'var(--color-slate-700)',
                      textDecorationLine: 'none',
                      transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                      transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                      transitionDuration: '150ms',
                      '&:hover': {
                        '@media (hover: hover)': {
                          backgroundColor: 'var(--color-slate-50)'
                        }
                      }
                    }), link(event.event.sourceHref, { target: 'workspace' })]}
                    aria-label={`Open ${sbarSectionLabel(event.event.sbarSection)} for ${event.event.handoverTitle}`}

                  ><AudioLinesIcon />{sbarSectionLabel(event.event.sbarSection)}</a> : <span mix={css({ fontSize: "0.75rem", lineHeight: "1.33333333", color: "var(--color-slate-500)" })}>{event.kind === 'review' && event.event.method === 'human' ? 'Manual edit' : 'Model update'}</span>}
                </div>
                <div mix={css({ marginTop: "0.5rem", fontSize: "0.875rem", lineHeight: "1.5rem", whiteSpace: "pre-wrap", color: "var(--color-slate-700)" })}>{eventPreviousValue(event) || 'No text'}</div>
              </li>)}
            </ol>
          </details> : null}
          {handle.props.reviewStatus === 'needs_review' && handle.props.alternatives?.length ? <div mix={css({
            marginTop: '0.5rem',
            ':where(& > :not(:last-child))': {
              marginBlockStart: '0px',
              marginBlockEnd: '0.25rem'
            },
            borderRadius: 'calc(var(--radius) * 0.8)',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'color-mix(in oklab, var(--color-amber-200) 70%, transparent)',
            backgroundColor: 'color-mix(in oklab, var(--color-amber-50) 70%, transparent)',
            paddingInline: '0.75rem',
            paddingBlock: '0.5rem',
            fontSize: '0.75rem',
            lineHeight: '1.25rem',
            color: 'var(--color-amber-900)'
          })}>
            <div mix={css({ fontWeight: "600" })}>Model alternatives</div>
            {handle.props.alternatives.slice(0, 3).map((alternative) => <div key={alternative} mix={css({ whiteSpace: "pre-wrap" })}>{alternative}</div>)}
          </div> : null}
        </div>
        <div mix={css({ display: "flex", justifyContent: "flex-start", "@media (width >= 48rem)": { justifyContent: "flex-end" } })}>{handle.props.action ? <button
          type="button"
          aria-label={`Edit ${handle.props.label}`}
          mix={[css({
            display: 'inline-flex',
            width: '2.25rem',
            height: '2.25rem',
            cursor: 'pointer',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'calc(infinity * 1px)',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'transparent',
            color: 'var(--color-slate-500)',
            transitionProperty: 'all',
            transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
            transitionDuration: '150ms',
            outlineStyle: 'none',
            '&:hover': {
              '@media (hover: hover)': {
                backgroundColor: 'var(--color-slate-100)',
                color: 'var(--primary)'
              }
            },
            '&:focus-visible': {
              borderColor: 'var(--ring)',
              boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
            }
          }), on('click', () => {
            value = editableValue(handle.props)
            editing = true
            handle.update()
          })]}
        ><PencilIcon /></button> : null}</div>
      </>}
    </div>
  }
})

function editableValue(props: PatientSheetFieldProps): string {
  return props.editValue ?? (props.hasCapturedValue === false ? '' : props.value ?? '')
}

function timestamp(value: string): number {
  let parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function formatVersionTimestamp(value: string): string {
  let parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return 'Unknown time'
  return parsed.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

function getEditEvents(props: PatientSheetFieldProps): EditEvent[] {
  let sbarUpdateEvents = props.sbarUpdateEvents ?? []
  return [
    ...sbarUpdateEvents.map((event): EditEvent => ({ kind: 'sbar', event })),
    ...(props.reviewEvents ?? [])
      .filter((event) => !isMirroredSbarReviewEvent(event, sbarUpdateEvents))
      .map((event): EditEvent => ({ kind: 'review', event })),
  ].sort((left, right) => timestamp(left.event.at) - timestamp(right.event.at))
}

function isMirroredSbarReviewEvent(event: ReviewEvent, sbarUpdateEvents: SbarUpdateEvent[]): boolean {
  if (event.method !== 'llm' || event.byUserId !== 'system:sbar-reconciliation') return false
  return sbarUpdateEvents.some((sbarEvent) =>
    sbarEvent.at === event.at
    && sbarEvent.previousValue === event.previousValue
    && sbarEvent.nextValue === event.nextValue,
  )
}

function eventPreviousValue(event: EditEvent): string {
  return event.event.previousValue ?? ''
}

function eventIdentity(event: EditEvent | null): string {
  if (!event) return 'original'
  let source = event.kind === 'sbar' ? event.event.handoverId : `${event.event.byUserId}:${event.event.method}`
  return `${event.kind}:${event.event.at}:${source}:${event.event.nextValue}`
}

function sbarSectionLabel(section: SbarUpdateEvent['sbarSection']): string {
  if (section === 'situation') return 'SBAR Situation'
  if (section === 'background') return 'SBAR Background'
  if (section === 'assessment') return 'SBAR Assessment'
  return 'SBAR Recommendation'
}

function PencilIcon() { return () => <svg viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg> }
function CheckIcon() { return () => <svg data-icon="inline-start" viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6" /></svg> }
function AudioLinesIcon() { return () => <svg data-icon="inline-start" viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3" /></svg> }

const buttonBaseStyles: Parameters<typeof css>[0] = {
  display: 'inline-flex',
  height: '1.75rem',
  flexShrink: '0',
  cursor: 'pointer',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.25rem',
  borderRadius: 'calc(infinity * 1px)',
  borderStyle: 'solid',
  borderWidth: '1px',
  borderColor: 'transparent',
  paddingInline: '0.625rem',
  fontSize: '0.8rem',
  fontWeight: '500',
  whiteSpace: 'nowrap',
  transitionProperty: 'all',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  outlineStyle: 'none',
  '&:focus-visible': {
    borderColor: 'var(--ring)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
  }
}
const primaryButtonStyles: Parameters<typeof css>[0] = {
  ...buttonBaseStyles,
  backgroundColor: 'var(--primary)',
  color: 'var(--primary-foreground)',
  '&:hover': {
    '@media (hover: hover)': {
      backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)'
    }
  }
}
const outlineButtonStyles: Parameters<typeof css>[0] = {
  ...buttonBaseStyles,
  borderColor: 'transparent',
  backgroundColor: 'var(--background)',
  color: 'var(--foreground)',
  '&:hover': {
    '@media (hover: hover)': {
      backgroundColor: 'var(--muted)'
    }
  }
}
