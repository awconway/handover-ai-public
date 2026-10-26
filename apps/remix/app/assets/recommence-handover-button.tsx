import { css, clientEntry, on, ref, type Handle, type SerializableProps } from 'remix/component'

import {
  RECORDING_STATUS_EVENT,
  requestPersistentRecording,
  type RecorderState,
  type RecordingRestartCue,
  type RecordingStatusDetail,
} from './recording-events.ts'

interface RecommenceHandoverButtonProps extends SerializableProps {
  action: string
  csrfToken?: string
  contextLabel: string
  restartCue?: string
  restartCueTitle?: string
  restartCueSubtitle?: string
  restartCues?: RecordingRestartCue[]
}

/** Starts a continuation capture directly, matching the recorder-first React flow. */
export const RecommenceHandoverButton = clientEntry(
  import.meta.url + '#RecommenceHandoverButton',
  function RecommenceHandoverButton(handle: Handle<RecommenceHandoverButtonProps>) {
    let recorderState: RecorderState = 'idle'
    let recorderMessage = ''
    let formId = `recommence-${handle.id}`

    return () => (
      <>
        <button
          type="button"
          data-testid="review-action-recommence"
          data-analytics-id="handover-recommence"
          disabled={recorderState !== 'idle' && recorderState !== 'error'}
          aria-describedby={recorderMessage ? `${formId}-message` : undefined}
          mix={[
            css({
              gridColumnStart: '1',
              gridRowStart: '1',
              display: 'flex',
              height: '3.5rem',
              minWidth: '0rem',
              cursor: 'pointer',
              alignItems: 'center',
              justifyContent: 'flex-start',
              gap: '0.5rem',
              borderRadius: '18px',
              backgroundColor: 'var(--primary)',
              paddingLeft: '0.75rem',
              paddingRight: '0.75rem',
              textAlign: 'left',
              fontSize: '.875rem',
              lineHeight: '1.25rem',
              fontWeight: 500,
              whiteSpace: 'normal',
              color: 'var(--primary-foreground)',
              transitionProperty:
                'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
              transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
              transitionDuration: '150ms',
              '@media (hover: hover)': {
                '&:hover': { backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)' },
              },
              '&:disabled': { cursor: 'not-allowed', opacity: 0.6 },
              '& svg': { width: '1.25rem', height: '1.25rem' },
              '@media (min-width: 48rem)': {
                gridColumn: 'auto',
                gridRow: 'auto',
                height: '2rem',
                width: '100%',
                justifyContent: 'center',
                gap: '0.375rem',
                borderRadius: '9999px',
                textAlign: 'center',
                lineHeight: 1.5,
                whiteSpace: 'nowrap',
                '& svg': { width: '1rem', height: '1rem' },
                boxShadow: '0 12px 30px rgba(91,116,156,0.18)',
              },
              boxShadow: '0 12px 26px rgba(91,116,156,0.16)',
            }),
            on('click', () => {
              if (recorderState !== 'idle' && recorderState !== 'error') return

              recorderState = 'requesting'
              recorderMessage = ''
              handle.update()

              let accepted = requestPersistentRecording({
                formId,
                submitAction: handle.props.action,
                uploadAction: handle.props.action,
                csrfToken: handle.props.csrfToken,
                contextLabel: handle.props.contextLabel,
                mode: 'extend',
                restartCue: handle.props.restartCue,
                restartCueTitle: handle.props.restartCueTitle,
                restartCueSubtitle: handle.props.restartCueSubtitle,
                restartCues: handle.props.restartCues,
                formData: new FormData(),
              })

              if (!accepted) {
                recorderState = 'error'
                recorderMessage = 'Finish or discard the current recording before recommencing another handover.'
                handle.update()
              }
            }),
            ref((_button, signal) => {
              window.addEventListener(
                RECORDING_STATUS_EVENT,
                (event) => {
                  let detail = (event as CustomEvent<RecordingStatusDetail>).detail
                  if (detail.formId !== formId) return
                  recorderState = detail.status
                  recorderMessage = detail.message ?? ''
                  handle.update()
                },
                { signal },
              )
            }),
          ]}
        >
          <RotateIcon />
          <span mix={css({ minWidth: '0rem' })}>{recommenceLabel(recorderState)}</span>
        </button>
        {recorderMessage && recorderState === 'error' ? (
          <p
            id={`${formId}-message`}
            role="alert"
            mix={css({
              gridColumn: 'span 3 / span 3',
              fontSize: '.875rem',
              lineHeight: '1.25rem',
              color: 'var(--color-rose-700)',
              '@media (min-width: 48rem)': { gridColumn: 'auto' },
            })}
          >
            {recorderMessage}
          </p>
        ) : null}
      </>
    )
  },
)

function recommenceLabel(state: RecorderState) {
  if (state === 'requesting') return 'Recommencing handover'
  if (state === 'recording' || state === 'paused') return 'Recording active'
  if (state === 'stopping' || state === 'submitting') return 'Updating handover'
  if (state === 'ready') return 'Upload needs attention'
  return 'Start recording again'
}

function RotateIcon() {
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
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}
