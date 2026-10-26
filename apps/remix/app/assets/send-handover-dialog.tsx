import { css, clientEntry, on, ref, type Handle, type SerializableProps } from 'remix/component'

import type { DirectoryOption } from '../ui/models.ts'
import { enhanceFrameMutation } from './frame-mutation.ts'

interface SendHandoverDialogProps extends SerializableProps {
  action: string
  handoverId: string
  handoverTitle: string
  recipients: DirectoryOption[]
  csrfToken?: string
}

/** Keeps assignment controls in the action-triggered dialog used by the React app. */
export const SendHandoverDialog = clientEntry(
  import.meta.url + '#SendHandoverDialog',
  function SendHandoverDialog(handle: Handle<SendHandoverDialogProps>) {
    let open = false
    let dialogId = `send-handover-${handle.id}`
    let selectedRecipientId = handle.props.recipients.length === 1 ? (handle.props.recipients[0]?.id ?? '') : ''
    let recipientQuery = ''
    let pending = false
    let error = ''
    let dialog: HTMLDialogElement | undefined

    function close() {
      if (pending) return
      if (dialog?.open) dialog.close()
      open = false
      handle.update()
    }

    return () => {
      let selectedRecipient = handle.props.recipients.find((recipient) => recipient.id === selectedRecipientId)
      let normalizedQuery = recipientQuery.trim().toLowerCase()
      let visibleRecipients = handle.props.recipients
        .filter(
          (recipient) =>
            !normalizedQuery ||
            `${recipient.label} ${recipient.description ?? ''}`.toLowerCase().includes(normalizedQuery),
        )
        .slice(0, 4)

      return (
        <>
          <button
            type="button"
            aria-label="Send handover"
            aria-haspopup="dialog"
            aria-expanded={open}
            data-testid="review-action-send"
            data-analytics-id="handover-send-open"
            mix={[
              css({
                gridColumnStart: '2',
                gridRowStart: '1',
                display: 'inline-flex',
                height: '3.5rem',
                minWidth: '0rem',
                cursor: 'pointer',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.25rem',
                borderRadius: '16px',
                borderWidth: '1px',
                borderStyle: 'solid',
                borderColor: 'transparent',
                backgroundColor: 'color-mix(in oklab, #fff 76%, transparent)',
                paddingLeft: '0.5rem',
                paddingRight: '0.5rem',
                fontSize: '.75rem',
                lineHeight: 1.3333333333333333,
                fontWeight: 500,
                color: 'var(--color-slate-800)',
                transitionProperty:
                  'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                transitionDuration: '150ms',
                '@media (hover: hover)': { '&:hover': { backgroundColor: '#fff' } },
                '@media (min-width: 48rem)': {
                  gridColumn: 'auto',
                  gridRow: 'auto',
                  height: '2rem',
                  width: '100%',
                  flexDirection: 'row',
                  gap: '0.375rem',
                  borderRadius: '9999px',
                  borderColor: 'var(--border)',
                  backgroundColor: 'var(--background)',
                  paddingLeft: '0.75rem',
                  paddingRight: '0.75rem',
                  fontSize: '.875rem',
                  lineHeight: 1.4285714285714286,
                  whiteSpace: 'nowrap',
                  color: 'var(--foreground)',
                  '@media (hover: hover)': {
                    '&:hover': { backgroundColor: 'var(--muted)', color: 'var(--foreground)' },
                  },
                  '& svg': { width: '1rem', height: '1rem' },
                  boxShadow: 'none',
                },
                '& svg': { width: '1.25rem', height: '1.25rem' },
                boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-200) 70%, transparent)',
              }),
              on('click', async () => {
                open = true
                let signal = await handle.update()
                if (!signal.aborted && dialog && !dialog.open) dialog.showModal()
              }),
            ]}
          >
            <SendIcon />
            <span
              data-testid="review-action-send-mobile-label"
              mix={css({ '@media (min-width: 48rem)': { display: 'none' } })}
            >
              Send
            </span>
            <span
              data-testid="review-action-send-desktop-label"
              mix={css({ display: 'none', '@media (min-width: 48rem)': { display: 'inline' } })}
            >
              Send handover
            </span>
          </button>

          {open ? (
            <dialog
              aria-labelledby={`${dialogId}-title`}
              aria-describedby={`${dialogId}-description`}
              data-analytics-id="send-handover-dialog"
              mix={[
                css({
                  margin: 'auto',
                  maxHeight: 'calc(100dvh - 2rem)',
                  width: 'calc(100% - 2rem)',
                  maxWidth: '42rem',
                  overflowY: 'auto',
                  borderRadius: 'calc(var(--radius) * 1.4)',
                  borderWidth: 0,
                  backgroundColor: 'var(--popover)',
                  padding: '0rem',
                  fontSize: '.875rem',
                  lineHeight: 1.4285714285714286,
                  color: 'var(--popover-foreground)',
                  outlineStyle: 'none',
                  '&::backdrop': {
                    backgroundColor: 'color-mix(in oklab, #000 10%, transparent)',
                    backdropFilter: 'blur(4px)',
                  },
                  boxShadow: '0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent)',
                }),
                ref((node) => {
                  dialog = node as HTMLDialogElement
                }),
                on('cancel', (event) => {
                  event.preventDefault()
                  close()
                }),
                on('click', (event) => {
                  if (event.target === event.currentTarget) close()
                }),
              ]}
            >
              <div mix={css({ padding: '1.5rem' })}>
                <div mix={css({ display: 'flex', flexDirection: 'column', gap: '0.5rem' })}>
                  <h2
                    id={`${dialogId}-title`}
                    mix={css({ fontFamily: 'var(--font-sans)', fontSize: '1rem', lineHeight: 1, fontWeight: 500 })}
                  >
                    Send handover
                  </h2>
                  <p
                    id={`${dialogId}-description`}
                    mix={css({ fontSize: '.875rem', lineHeight: 1.4285714285714286, color: 'var(--muted-foreground)' })}
                  >
                    Assign one or more handovers to a collaborating clinician. They will receive the handover in their
                    inbox and decide which shift to place it into.
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Close"
                  disabled={pending}
                  mix={[
                    css({
                      position: 'absolute',
                      top: '0.5rem',
                      right: '0.5rem',
                      display: 'inline-flex',
                      width: '2rem',
                      height: '2rem',
                      cursor: 'pointer',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 'var(--radius)',
                      color: 'var(--color-slate-500)',
                      transitionProperty:
                        'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                      transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                      transitionDuration: '150ms',
                      '@media (hover: hover)': {
                        '&:hover': { backgroundColor: 'var(--muted)', color: 'var(--foreground)' },
                      },
                    }),
                    on('click', close),
                  ]}
                >
                  <CloseIcon />
                </button>

                <form
                  method="post"
                  action={handle.props.action}
                  data-workflow="send-handover"
                  data-study-task="task-send-handover"
                  aria-busy={pending || undefined}
                  mix={[
                    css({ marginTop: '1.5rem', display: 'grid', gap: '1.25rem' }),
                    enhanceFrameMutation(handle, {
                      onPending(value) {
                        pending = value
                        if (value) error = ''
                      },
                      onError(message) {
                        error = message
                      },
                      onRefreshError() {
                        error = 'The handover was sent, but the workspace could not be refreshed.'
                      },
                      onSuccess() {
                        if (dialog?.open) dialog.close()
                        open = false
                        error = ''
                      },
                    }),
                  ]}
                >
                  {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
                  <input type="hidden" name="handoverIds" value={handle.props.handoverId} />
                  {selectedRecipientId ? (
                    <input type="hidden" name="assignedToUserId" value={selectedRecipientId} />
                  ) : null}
                  {error ? (
                    <div
                      role="alert"
                      mix={css({
                        borderRadius: '14px',
                        borderWidth: '1px',
                        borderStyle: 'solid',
                        borderColor: 'var(--color-rose-200)',
                        backgroundColor: 'var(--color-rose-50)',
                        paddingLeft: '0.75rem',
                        paddingRight: '0.75rem',
                        paddingTop: '0.5rem',
                        paddingBottom: '0.5rem',
                        fontSize: '.875rem',
                        lineHeight: '1.5rem',
                        color: 'var(--color-rose-900)',
                      })}
                    >
                      {error}
                    </div>
                  ) : null}
                  <div mix={css({ display: 'grid', gap: '0.5rem' })}>
                    <label
                      htmlFor={`${dialogId}-recipient-search`}
                      mix={css({
                        fontSize: '.875rem',
                        lineHeight: 1.4285714285714286,
                        fontWeight: 500,
                        color: 'var(--color-slate-900)',
                      })}
                    >
                      Receiving clinician
                    </label>
                    {handle.props.recipients.length ? (
                      <>
                        <input
                          id={`${dialogId}-recipient-search`}
                          type="search"
                          value={recipientQuery}
                          disabled={pending}
                          placeholder="Search for a clinician"
                          mix={[
                            css({
                              display: 'block',
                              height: '2.75rem',
                              width: '100%',
                              minWidth: '0rem',
                              borderRadius: '18px',
                              borderWidth: '1px',
                              borderStyle: 'solid',
                              borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                              backgroundColor: '#fff',
                              paddingLeft: '0.75rem',
                              paddingRight: '0.75rem',
                              fontSize: '.875rem',
                              lineHeight: 1.4285714285714286,
                              color: 'var(--color-slate-900)',
                              outlineStyle: 'none',
                              '&:focus-visible': {
                                borderColor: 'var(--ring)',
                                boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 40%, transparent)',
                              },
                            }),
                            on('input', (event) => {
                              recipientQuery = event.currentTarget.value
                              handle.update()
                            }),
                          ]}
                        />
                        <div
                          role="status"
                          mix={css({
                            borderRadius: '14px',
                            borderWidth: '1px',
                            borderStyle: 'solid',
                            paddingLeft: '0.75rem',
                            paddingRight: '0.75rem',
                            paddingTop: '0.5rem',
                            paddingBottom: '0.5rem',
                            fontSize: '.875rem',
                            lineHeight: '1.5rem',
                            ...(selectedRecipient
                              ? {
                                  borderColor: 'var(--color-emerald-200)',
                                  backgroundColor: 'var(--color-emerald-50)',
                                  color: 'var(--color-emerald-800)',
                                }
                              : {
                                  borderColor: 'var(--color-slate-200)',
                                  backgroundColor: 'var(--color-slate-50)',
                                  color: 'var(--color-slate-600)',
                                }),
                          })}
                        >
                          {selectedRecipient
                            ? `${selectedRecipient.label} is selected as the receiving clinician.`
                            : 'No receiving clinician is selected. Select one from the search results before sending.'}
                        </div>
                        <div
                          mix={css({
                            display: 'flex',
                            maxHeight: '10rem',
                            flexWrap: 'wrap',
                            gap: '0.5rem',
                            overflowY: 'auto',
                          })}
                          aria-label="Receiving clinicians"
                        >
                          {visibleRecipients.length ? (
                            visibleRecipients.map((recipient) => {
                              let selected = recipient.id === selectedRecipientId
                              return (
                                <button
                                  key={recipient.id}
                                  type="button"
                                  aria-pressed={selected}
                                  aria-label={`${selected ? 'Remove' : 'Select'} ${recipient.label} as receiving clinician`}
                                  disabled={pending}
                                  mix={[
                                    css({
                                      display: 'inline-flex',
                                      height: '2rem',
                                      maxWidth: '100%',
                                      cursor: 'pointer',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      gap: '0.375rem',
                                      borderRadius: '9999px',
                                      borderWidth: '1px',
                                      borderStyle: 'solid',
                                      paddingLeft: '0.75rem',
                                      paddingRight: '0.75rem',
                                      fontSize: '.875rem',
                                      lineHeight: 1.4285714285714286,
                                      fontWeight: 500,
                                      transitionProperty:
                                        'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                                      transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                                      transitionDuration: '150ms',
                                      ...(selected
                                        ? {
                                            borderColor: 'var(--primary)',
                                            backgroundColor: 'var(--primary)',
                                            color: 'var(--primary-foreground)',
                                          }
                                        : {
                                            borderColor: 'var(--border)',
                                            backgroundColor: 'var(--background)',
                                            color: 'var(--foreground)',
                                            '@media (hover: hover)': { '&:hover': { backgroundColor: 'var(--muted)' } },
                                          }),
                                    }),
                                    on('click', () => {
                                      selectedRecipientId = selected ? '' : recipient.id
                                      handle.update()
                                    }),
                                  ]}
                                >
                                  {selected ? <CheckIcon /> : null}
                                  <span
                                    mix={css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })}
                                  >
                                    {recipient.label}
                                  </span>
                                </button>
                              )
                            })
                          ) : (
                            <p
                              mix={css({
                                fontSize: '.875rem',
                                lineHeight: 1.4285714285714286,
                                color: 'var(--color-slate-500)',
                              })}
                            >
                              No clinicians match that search.
                            </p>
                          )}
                        </div>
                        <p
                          mix={css({
                            fontSize: '.875rem',
                            lineHeight: 1.4285714285714286,
                            color: 'var(--color-slate-500)',
                          })}
                        >
                          {selectedRecipient
                            ? `Selected: ${selectedRecipient.label}${selectedRecipient.description ? ` · ${selectedRecipient.description}` : ''}.`
                            : 'The Send handover button stays disabled until a clinician is selected.'}
                        </p>
                      </>
                    ) : (
                      <span
                        role="status"
                        mix={css({
                          borderRadius: '14px',
                          borderWidth: '1px',
                          borderStyle: 'solid',
                          borderColor: 'var(--color-amber-200)',
                          backgroundColor: 'var(--color-amber-50)',
                          paddingLeft: '0.75rem',
                          paddingRight: '0.75rem',
                          paddingTop: '0.5rem',
                          paddingBottom: '0.5rem',
                          fontSize: '.875rem',
                          lineHeight: '1.5rem',
                          fontWeight: 400,
                          color: 'var(--color-amber-800)',
                        })}
                      >
                        No receiving clinicians are available. Add another clinician before sending this handover.
                      </span>
                    )}
                  </div>

                  <div mix={css({ display: 'grid', gap: '0.5rem' })}>
                    <div
                      mix={css({
                        fontSize: '.875rem',
                        lineHeight: 1.4285714285714286,
                        fontWeight: 500,
                        color: 'var(--color-slate-900)',
                      })}
                    >
                      Handover to send
                    </div>
                    <div
                      mix={css({
                        display: 'grid',
                        gap: '0.5rem',
                        borderRadius: '18px',
                        borderWidth: '1px',
                        borderStyle: 'solid',
                        borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                        backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 70%, transparent)',
                        padding: '0.75rem',
                      })}
                    >
                      <div
                        mix={css({
                          borderRadius: '14px',
                          borderWidth: '1px',
                          borderStyle: 'solid',
                          borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                          backgroundColor: '#fff',
                          paddingLeft: '0.75rem',
                          paddingRight: '0.75rem',
                          paddingTop: '0.5rem',
                          paddingBottom: '0.5rem',
                          fontSize: '.875rem',
                          lineHeight: 1.4285714285714286,
                          color: 'var(--color-slate-900)',
                        })}
                      >
                        {handle.props.handoverTitle}
                      </div>
                    </div>
                    <p
                      mix={css({
                        fontSize: '.875rem',
                        lineHeight: 1.4285714285714286,
                        color: 'var(--color-slate-500)',
                      })}
                    >
                      One handover will be sent.
                    </p>
                  </div>

                  <div
                    mix={css({
                      marginLeft: '-1rem',
                      marginRight: '-1rem',
                      marginBottom: '-1rem',
                      marginTop: '1.5rem',
                      display: 'flex',
                      flexDirection: 'column-reverse',
                      gap: '0.5rem',
                      borderBottomLeftRadius: 'calc(var(--radius) * 1.4)',
                      borderBottomRightRadius: 'calc(var(--radius) * 1.4)',
                      borderTopWidth: '1px',
                      borderTopStyle: 'solid',
                      backgroundColor: 'color-mix(in oklab, var(--muted) 50%, transparent)',
                      padding: '1rem',
                      '@media (min-width: 40rem)': { flexDirection: 'row', justifyContent: 'flex-end' },
                    })}
                  >
                    <button
                      type="button"
                      disabled={pending}
                      data-analytics-id="send-handover-cancel"
                      mix={[css(secondaryButtonStyles), on('click', close)]}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      mix={css(primaryButtonStyles)}
                      data-analytics-id="send-handover-submit"
                      disabled={pending || !selectedRecipientId}
                    >
                      <SendIcon />
                      {pending ? 'Sending handover' : 'Send handover'}
                    </button>
                  </div>
                </form>
              </div>
            </dialog>
          ) : null}
        </>
      )
    }
  },
)

function SendIcon() {
  return () => (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  )
}

function CheckIcon() {
  return () => (
    <svg
      aria-hidden="true"
      mix={css({ width: '0.875rem', height: '0.875rem' })}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="m5 12 4 4L19 6" />
    </svg>
  )
}

function CloseIcon() {
  return () => (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      mix={css({ width: '1rem', height: '1rem' })}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

const dialogButtonBaseStyles = {
  display: 'inline-flex',
  height: '2rem',
  cursor: 'pointer',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.375rem',
  borderRadius: 'var(--radius)',
  paddingLeft: '0.625rem',
  paddingRight: '0.625rem',
  fontSize: '.875rem',
  lineHeight: 1.4285714285714286,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  transitionProperty:
    'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  '&:disabled': { cursor: 'not-allowed', opacity: 0.6 },
  '& svg': { width: '1rem', height: '1rem', flexShrink: 0 },
} satisfies Parameters<typeof css>[0]
const primaryButtonStyles = {
  ...dialogButtonBaseStyles,
  backgroundColor: 'var(--primary)',
  color: 'var(--primary-foreground)',
  '@media (hover: hover)': { '&:hover': { backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)' } },
} satisfies Parameters<typeof css>[0]
const secondaryButtonStyles = {
  ...dialogButtonBaseStyles,
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'var(--border)',
  backgroundColor: 'var(--background)',
  color: 'var(--foreground)',
  '@media (hover: hover)': { '&:hover': { backgroundColor: 'var(--muted)' } },
} satisfies Parameters<typeof css>[0]
