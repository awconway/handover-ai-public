import { css, clientEntry, on, ref, type Handle, type SerializableProps } from 'remix/component'

import { enhanceFrameMutation } from './frame-mutation.ts'
import { wakeProcessingCoordinator } from './processing-events.ts'

interface ProcessingTimelineProps extends SerializableProps {
  handoverId: string
  status: 'queued' | 'transcribing' | 'analysing' | 'completed' | 'failed' | 'draft'
  startedAt?: string
  updatedAt?: string
  retryAction?: string
  discardAction?: string
  csrfToken?: string
  tickMs?: number
  transcriptAvailable?: boolean
}

const PROCESSING_ELAPSED_WARNING_MS = 2 * 60 * 1_000

function formatProcessingElapsed(startAt: string | undefined, referenceMs = Date.now()): string {
  if (!startAt) return 'Ready'
  let startMs = new Date(startAt).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(referenceMs)) return 'Ready'
  let totalSeconds = Math.max(0, Math.floor((referenceMs - startMs) / 1_000))
  if (totalSeconds < 60) return `${totalSeconds}s elapsed`
  let minutes = Math.floor(totalSeconds / 60)
  let seconds = totalSeconds % 60
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s elapsed` : `${minutes}m elapsed`
  let hours = Math.floor(minutes / 60)
  let remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours}h ${remainingMinutes}m elapsed` : `${hours}h elapsed`
}

function isActive(status: ProcessingTimelineProps['status']): boolean {
  return status !== 'completed' && status !== 'failed'
}

export const ProcessingTimeline = clientEntry(
  import.meta.url + '#ProcessingTimeline',
  function ProcessingTimeline(handle: Handle<ProcessingTimelineProps>) {
    let nowMs = Date.now()
    let retryPending = false
    let retryError = ''
    let discardOpen = false
    let discardDialog: HTMLDialogElement | undefined
    let discardTitleId = `discard-failed-handover-title-${handle.id}`
    let discardDescriptionId = `discard-failed-handover-description-${handle.id}`

    function closeDiscard() {
      if (discardDialog?.open) discardDialog.close()
      discardOpen = false
      handle.update()
    }

    return () => {
      let active = isActive(handle.props.status)
      let completed = handle.props.status === 'completed'
      let failed = handle.props.status === 'failed'
      let analysing = handle.props.status === 'analysing'
      let transcribed = completed || analysing || (failed && handle.props.transcriptAvailable === true)
      let referenceMs = active ? nowMs : handle.props.updatedAt ? new Date(handle.props.updatedAt).getTime() : nowMs
      let startMs = handle.props.startedAt ? new Date(handle.props.startedAt).getTime() : Number.NaN
      let elapsedWarning = active && Number.isFinite(startMs) && nowMs - startMs >= PROCESSING_ELAPSED_WARNING_MS
      let elapsedLabel =
        completed && !handle.props.startedAt
          ? 'Complete'
          : failed && !handle.props.startedAt
            ? 'Processing stopped'
            : formatProcessingElapsed(handle.props.startedAt, referenceMs)
      let steps = [
        {
          label: transcribed ? 'Transcribed' : 'Transcribing',
          state: transcribed ? 'complete' : failed ? 'failed' : 'current',
        },
        {
          label: completed ? 'Analysed' : 'Analysing',
          state: completed ? 'complete' : failed && transcribed ? 'failed' : analysing ? 'current' : 'upcoming',
        },
      ] as const
      return (
        <>
          <span
            hidden
            aria-hidden="true"
            data-processing-timeline-clock="true"
            data-processing-handover-id={handle.props.handoverId}
            data-processing-active={active ? 'true' : 'false'}
            mix={ref((_node, signal) => {
              let interval = window.setInterval(() => {
                if (!isActive(handle.props.status)) return
                nowMs = Date.now()
                handle.update()
              }, handle.props.tickMs ?? 1_000)
              signal.addEventListener('abort', () => window.clearInterval(interval), { once: true })
            })}
          />
          <section
            aria-label="Processing timeline"
            mix={css({
              overflow: 'hidden',
              borderRadius: '18px',
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: 'color-mix(in oklab, var(--color-slate-200) 70%, transparent)',
              backgroundColor: 'color-mix(in oklab, #fff 72%, transparent)',
              paddingTop: '0.5rem',
              paddingBottom: '0.5rem',
              fontSize: '.875rem',
              lineHeight: 1.4285714285714286,
              color: 'var(--card-foreground)',
              boxShadow: '0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent)',
            })}
          >
            <div
              mix={css({
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: '0.5rem',
                paddingLeft: '0.75rem',
                paddingRight: '0.75rem',
                paddingTop: '0.625rem',
                paddingBottom: '0.625rem',
                '@media (min-width: 40rem)': { paddingLeft: '1rem', paddingRight: '1rem' },
              })}
            >
              <div
                mix={css({
                  fontSize: '10px',
                  fontWeight: 500,
                  textTransform: 'uppercase',
                  letterSpacing: '0.14em',
                  color: 'var(--color-slate-500)',
                })}
              >
                Timeline
              </div>
              <div
                data-testid="processing-step-list"
                mix={css({
                  display: 'grid',
                  width: '100%',
                  minWidth: '0rem',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  gap: '0.375rem',
                  '@media (min-width: 40rem)': { width: 'auto', flex: '1', maxWidth: '22rem' },
                })}
              >
                {steps.map((step) => (
                  <div
                    key={step.label}
                    mix={css({
                      position: 'relative',
                      minWidth: '0rem',
                      overflow: 'hidden',
                      borderRadius: '9999px',
                      borderWidth: '1px',
                      borderStyle: 'solid',
                      paddingLeft: '0.5rem',
                      paddingRight: '0.5rem',
                      paddingTop: '0.25rem',
                      paddingBottom: '0.25rem',
                      transitionProperty:
                        'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
                      transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                      transitionDuration: '150ms',
                      '@media (min-width: 40rem)': { paddingLeft: '0.625rem', paddingRight: '0.625rem' },
                      ...(step.state === 'complete'
                        ? {
                            borderColor: 'color-mix(in oklab, var(--color-slate-300) 80%, transparent)',
                            backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 90%, transparent)',
                            color: 'var(--color-slate-700)',
                          }
                        : step.state === 'current'
                          ? {
                              borderColor: 'color-mix(in oklab, var(--color-slate-400) 80%, transparent)',
                              backgroundColor: '#fff',
                              color: 'var(--color-slate-900)',
                            }
                          : step.state === 'failed'
                            ? {
                                borderColor: 'color-mix(in oklab, var(--color-rose-200) 70%, transparent)',
                                backgroundColor: 'color-mix(in oklab, var(--color-rose-50) 60%, transparent)',
                                color: 'var(--color-rose-900)',
                              }
                            : {
                                borderColor: 'color-mix(in oklab, var(--color-slate-200) 70%, transparent)',
                                backgroundColor: 'color-mix(in oklab, #fff 70%, transparent)',
                                color: 'var(--color-slate-500)',
                              }),
                    })}
                  >
                    {step.state === 'current' ? (
                      <span
                        aria-hidden="true"
                        mix={css({
                          position: 'absolute',
                          inset: '1px',
                          animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                          borderRadius: '9999px',
                          backgroundColor: 'color-mix(in oklab, var(--color-slate-100) 75%, transparent)',
                        })}
                      />
                    ) : null}
                    <span
                      mix={css({
                        position: 'relative',
                        zIndex: 10,
                        display: 'flex',
                        minWidth: '0rem',
                        alignItems: 'center',
                        gap: '0.375rem',
                      })}
                    >
                      <span
                        mix={css({
                          display: 'flex',
                          width: '18px',
                          height: '18px',
                          flexShrink: 0,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: '9999px',
                          ...(step.state === 'complete'
                            ? {
                                backgroundColor: 'color-mix(in oklab, var(--color-slate-200) 70%, transparent)',
                                color: 'var(--color-slate-700)',
                                boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-300) 80%, transparent)',
                              }
                            : step.state === 'current'
                              ? {
                                  backgroundColor: 'var(--color-slate-100)',
                                  color: 'var(--color-slate-800)',
                                  boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-300) 80%, transparent)',
                                }
                              : step.state === 'failed'
                                ? {
                                    backgroundColor: 'color-mix(in oklab, var(--color-rose-500) 10%, transparent)',
                                    color: 'var(--color-rose-700)',
                                    boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-rose-500) 15%, transparent)',
                                  }
                                : {
                                    backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 4%, transparent)',
                                    color: 'var(--color-slate-500)',
                                    boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-950) 8%, transparent)',
                                  }),
                        })}
                      >
                        {step.state === 'complete' ? (
                          <CheckIcon />
                        ) : step.state === 'current' ? (
                          <SpinnerIcon />
                        ) : step.state === 'failed' ? (
                          <AlertIcon />
                        ) : (
                          <span
                            mix={css({
                              width: '0.375rem',
                              height: '0.375rem',
                              borderRadius: '9999px',
                              backgroundColor: 'color-mix(in oklab, currentColor 70%, transparent)',
                            })}
                          />
                        )}
                      </span>
                      <span
                        mix={css({
                          minWidth: '0rem',
                          whiteSpace: 'nowrap',
                          fontSize: '11px',
                          lineHeight: '1rem',
                          fontWeight: 400,
                          '@media (min-width: 40rem)': { fontSize: '.75rem', lineHeight: '1rem' },
                        })}
                      >
                        {step.label}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
              {elapsedWarning ? (
                <span
                  mix={css({
                    display: 'inline-flex',
                    height: '1.25rem',
                    width: 'fit-content',
                    flexShrink: 0,
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                    borderRadius: 'calc(var(--radius) * 2.6)',
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    borderColor: 'transparent',
                    backgroundColor: 'color-mix(in oklab, var(--color-amber-500) 8%, transparent)',
                    paddingLeft: '0.5rem',
                    paddingRight: '0.5rem',
                    paddingTop: '0.125rem',
                    paddingBottom: '0.125rem',
                    fontSize: '.75rem',
                    lineHeight: 1.3333333333333333,
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                    color: 'var(--color-amber-800)',
                    boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-amber-500) 15%, transparent)',
                  })}
                >
                  Taking longer than usual
                </span>
              ) : null}
              {failed && handle.props.retryAction ? (
                <form
                  method="post"
                  action={handle.props.retryAction}
                  aria-busy={retryPending || undefined}
                  mix={enhanceFrameMutation(handle, {
                    onPending(value) {
                      retryPending = value
                      if (value) retryError = ''
                    },
                    onError(message) {
                      retryError = message
                    },
                    onSuccess() {
                      wakeProcessingCoordinator()
                    },
                    onRefreshError() {
                      retryError = 'Processing restarted, but the timeline could not be refreshed.'
                    },
                  })}
                >
                  {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
                  <button
                    type="submit"
                    disabled={retryPending}
                    data-testid="retry-processing"
                    mix={css({
                      display: 'inline-flex',
                      height: '2rem',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.375rem',
                      borderRadius: '9999px',
                      borderWidth: '1px',
                      borderStyle: 'solid',
                      borderColor: 'color-mix(in oklab, var(--color-slate-300) 80%, transparent)',
                      backgroundColor: '#fff',
                      paddingLeft: '0.75rem',
                      paddingRight: '0.75rem',
                      fontSize: '.75rem',
                      lineHeight: 1.3333333333333333,
                      fontWeight: 500,
                      color: 'var(--color-slate-700)',
                      transitionProperty:
                        'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                      transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                      transitionDuration: '150ms',
                      '@media (hover: hover)': { '&:hover': { backgroundColor: 'var(--color-slate-50)' } },
                      '&:disabled': { pointerEvents: 'none', opacity: 0.5 },
                      boxShadow: 'none',
                    })}
                  >
                    <RotateIcon />
                    {retryPending ? 'Retrying' : 'Try again'}
                  </button>
                  {retryError ? (
                    <span
                      role="alert"
                      mix={css({
                        marginLeft: '0.5rem',
                        fontSize: '.75rem',
                        lineHeight: 1.3333333333333333,
                        color: 'var(--color-rose-700)',
                      })}
                    >
                      {retryError}
                    </span>
                  ) : null}
                </form>
              ) : null}
              {failed && handle.props.discardAction ? (
                <>
                  <button
                    type="button"
                    aria-label="Discard failed attempt"
                    aria-haspopup="dialog"
                    aria-expanded={discardOpen}
                    data-testid="discard-failed-handover"
                    data-analytics-id="handover-failed-discard-open"
                    mix={[
                      css({
                        display: 'inline-flex',
                        height: '2rem',
                        cursor: 'pointer',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.375rem',
                        borderRadius: '9999px',
                        borderWidth: '1px',
                        borderStyle: 'solid',
                        borderColor: 'color-mix(in oklab, var(--color-rose-200) 80%, transparent)',
                        backgroundColor: '#fff',
                        paddingLeft: '0.75rem',
                        paddingRight: '0.75rem',
                        fontSize: '.75rem',
                        lineHeight: 1.3333333333333333,
                        fontWeight: 500,
                        color: 'var(--color-rose-700)',
                        transitionProperty:
                          'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                        transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                        transitionDuration: '150ms',
                        '@media (hover: hover)': { '&:hover': { backgroundColor: 'var(--color-rose-50)' } },
                        boxShadow: 'none',
                      }),
                      on('click', async () => {
                        discardOpen = true
                        let signal = await handle.update()
                        if (!signal.aborted && discardDialog && !discardDialog.open) discardDialog.showModal()
                      }),
                    ]}
                  >
                    <TrashIcon />
                    <span>Discard attempt</span>
                  </button>
                  {discardOpen ? (
                    <dialog
                      aria-labelledby={discardTitleId}
                      aria-describedby={discardDescriptionId}
                      mix={[
                        css({
                          margin: 'auto',
                          display: 'grid',
                          maxHeight: 'calc(100dvh - 2rem)',
                          width: 'calc(100% - 2rem)',
                          maxWidth: '24rem',
                          overflowY: 'auto',
                          borderRadius: 'calc(var(--radius) * 1.4)',
                          borderWidth: 0,
                          backgroundColor: 'var(--popover)',
                          padding: '1rem',
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
                          discardDialog = node as HTMLDialogElement
                        }),
                        on('cancel', (event) => {
                          event.preventDefault()
                          closeDiscard()
                        }),
                        on('click', (event) => {
                          if (event.target === event.currentTarget) closeDiscard()
                        }),
                      ]}
                    >
                      <div mix={css({ display: 'flex', flexDirection: 'column', gap: '0.5rem' })}>
                        <h2
                          id={discardTitleId}
                          mix={css({
                            fontFamily: 'var(--font-sans)',
                            fontSize: '1rem',
                            lineHeight: 1,
                            fontWeight: 500,
                          })}
                        >
                          Discard failed attempt?
                        </h2>
                        <p
                          id={discardDescriptionId}
                          mix={css({
                            fontSize: '.875rem',
                            lineHeight: 1.4285714285714286,
                            color: 'var(--muted-foreground)',
                          })}
                        >
                          Remove the failed recording, transcript, and analysis attempt. If this was a recommenced
                          handover, the last completed handover will be kept.
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label="Close"
                        mix={[
                          css({
                            position: 'absolute',
                            top: '0.5rem',
                            right: '0.5rem',
                            display: 'inline-flex',
                            width: '2rem',
                            height: '2rem',
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
                          on('click', closeDiscard),
                        ]}
                      >
                        <CloseIcon />
                      </button>
                      <form
                        method="post"
                        action={handle.props.discardAction}
                        mix={css({
                          marginLeft: '-1rem',
                          marginRight: '-1rem',
                          marginBottom: '-1rem',
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
                        data-workflow="discard-failed-handover-attempt"
                      >
                        {handle.props.csrfToken ? (
                          <input type="hidden" name="_csrf" value={handle.props.csrfToken} />
                        ) : null}
                        <button type="button" mix={[css(dialogOutlineButtonStyles), on('click', closeDiscard)]}>
                          Cancel
                        </button>
                        <button type="submit" mix={css(dialogDestructiveButtonStyles)}>
                          Discard failed attempt
                        </button>
                      </form>
                    </dialog>
                  ) : null}
                </>
              ) : null}
              <span
                mix={css({
                  display: 'inline-flex',
                  height: '1.25rem',
                  width: 'fit-content',
                  flexShrink: 0,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '9999px',
                  borderWidth: '1px',
                  borderStyle: 'solid',
                  borderColor: 'transparent',
                  backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 90%, transparent)',
                  paddingLeft: '0.5rem',
                  paddingRight: '0.5rem',
                  paddingTop: '0.125rem',
                  paddingBottom: '0.125rem',
                  fontSize: '11px',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                  color: 'var(--color-slate-600)',
                  boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-950) 8%, transparent)',
                })}
              >
                {elapsedLabel}
              </span>
            </div>
          </section>
        </>
      )
    }
  },
)

function CheckIcon() {
  return () => (
    <svg
      mix={css({ width: '0.75rem', height: '0.75rem' })}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12 4 4L19 6" />
    </svg>
  )
}
function AlertIcon() {
  return () => (
    <svg
      mix={css({ width: '0.75rem', height: '0.75rem' })}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  )
}
function SpinnerIcon() {
  return () => (
    <svg
      role="status"
      aria-label="Loading"
      mix={css({ width: '0.75rem', height: '0.75rem', animation: 'spin 1s linear infinite' })}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
    </svg>
  )
}
function RotateIcon() {
  return () => (
    <svg
      mix={css({ width: '0.875rem', height: '0.875rem' })}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}
function TrashIcon() {
  return () => (
    <svg
      data-icon="inline-start"
      viewBox="0 0 24 24"
      aria-hidden="true"
      mix={css({ width: '0.875rem', height: '0.875rem' })}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6" />
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

const dialogButtonStyles = {
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
  transitionProperty:
    'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  '&:disabled': { cursor: 'not-allowed', opacity: 0.6 },
} satisfies Parameters<typeof css>[0]
const dialogOutlineButtonStyles = {
  ...dialogButtonStyles,
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'var(--border)',
  backgroundColor: 'var(--background)',
  color: 'var(--foreground)',
  '@media (hover: hover)': { '&:hover': { backgroundColor: 'var(--muted)' } },
} satisfies Parameters<typeof css>[0]
const dialogDestructiveButtonStyles = {
  ...dialogButtonStyles,
  backgroundColor: 'var(--destructive)',
  color: '#fff',
  '@media (hover: hover)': {
    '&:hover': { backgroundColor: 'color-mix(in oklab, var(--destructive) 90%, transparent)' },
  },
} satisfies Parameters<typeof css>[0]
