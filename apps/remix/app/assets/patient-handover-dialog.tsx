import { css, clientEntry, on, ref, type Handle, type SerializableProps } from 'remix/component'

import { NewHandoverForm } from './new-handover-form.tsx'
import {
  RECORDING_STATUS_EVENT,
  cancelPersistentRecording,
  type RecorderState,
  type RecordingStatusDetail,
} from './recording-events.ts'

type Direction = 'incoming' | 'intra-shift' | 'outgoing'

interface PatientHandoverDialogProps extends SerializableProps {
  action: string
  uploadAction?: string
  csrfToken?: string
  direction: Direction
  variant?: 'primary' | 'outline'
  triggerPresentation?: 'compact' | 'patient-card'
  patient: { key: string; displayName: string; location?: string }
  shift: { id: string; title: string; department?: string }
  defaultDepartment?: string
  defaultParticipants?: string[]
}

/** Patient-linked handovers stay in context; only this native dialog hydrates. */
export const PatientHandoverDialog = clientEntry(
  import.meta.url + '#PatientHandoverDialog',
  function PatientHandoverDialog(handle: Handle<PatientHandoverDialogProps>) {
    let open = false
    let directionLabel =
      handle.props.direction === 'outgoing'
        ? 'delivering'
        : handle.props.direction === 'intra-shift'
          ? 'intra-shift'
          : 'receiving'
    let triggerLabel = `${directionLabel === 'intra-shift' ? 'Intra-shift' : `${directionLabel[0]?.toUpperCase()}${directionLabel.slice(1)}`} handover`
    let heading = `Start ${directionLabel} handover`
    let formId = `patient-${handle.props.patient.key.replace(/[^a-zA-Z0-9_-]/g, '-')}-${handle.props.direction}-handover-form`
    let dialog: HTMLDialogElement | undefined
    let recorderState: RecorderState = 'idle'

    function close(options: { cancelPending?: boolean } = {}) {
      if (options.cancelPending !== false && recorderState === 'requesting') {
        cancelPersistentRecording(formId)
      }
      if (dialog?.open) dialog.close()
      open = false
      handle.update()
    }

    return () => (
      <>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          data-direction={handle.props.direction}
          mix={[
            css(
              handle.props.triggerPresentation === 'patient-card'
                ? patientCardActionStyles
                : handle.props.variant === 'primary'
                  ? patientPrimaryActionStyles
                  : patientSecondaryActionStyles,
            ),
            on('click', async () => {
              open = true
              let signal = await handle.update()
              if (!signal.aborted && dialog && !dialog.open) dialog.showModal()
            }),
            ref((_button, signal) => {
              window.addEventListener(
                RECORDING_STATUS_EVENT,
                (event) => {
                  let detail = (event as CustomEvent<RecordingStatusDetail>).detail
                  if (detail.formId !== formId) return
                  recorderState = detail.status
                  if (detail.status === 'recording' && open) close({ cancelPending: false })
                },
                { signal },
              )
            }),
          ]}
        >
          {directionIcon(handle.props.direction, handle.props.triggerPresentation === 'patient-card')}
          {triggerLabel}
        </button>

        {open ? (
          <dialog
            aria-labelledby={`${formId}-title`}
            aria-describedby={`${formId}-description`}
            data-testid="patient-handover-dialog"
            data-layout="centered-modal"
            mix={[
              css({
                margin: 'auto',
                maxHeight: 'calc(100dvh - 2rem)',
                width: 'calc(100% - 2rem)',
                maxWidth: '42rem',
                overflowY: 'auto',
                borderRadius: '24px',
                borderWidth: 0,
                backgroundColor: '#fff',
                padding: '0rem',
                fontSize: '.875rem',
                lineHeight: 1.4285714285714286,
                color: 'var(--color-slate-950)',
                outlineStyle: 'none',
                '&::backdrop': {
                  backgroundColor: 'color-mix(in oklab, #000 10%, transparent)',
                  backdropFilter: 'blur(4px)',
                },
                boxShadow:
                  '0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent), 0 18px 48px rgba(44,56,75,0.14)',
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
            <div
              mix={css({
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
                paddingLeft: '1.25rem',
                paddingRight: '1.25rem',
                paddingTop: '1.25rem',
                '@media (min-width: 40rem)': { paddingLeft: '1.5rem', paddingRight: '1.5rem', paddingTop: '1.5rem' },
              })}
            >
              <h2
                id={`${formId}-title`}
                mix={css({
                  fontFamily: 'var(--font-sans)',
                  fontSize: '1.25rem',
                  lineHeight: '1.75rem',
                  fontWeight: 500,
                  color: 'var(--color-slate-950)',
                })}
              >
                {heading}
              </h2>
              <p
                id={`${formId}-description`}
                mix={css({
                  position: 'absolute',
                  width: '1px',
                  height: '1px',
                  padding: 0,
                  margin: '-1px',
                  overflow: 'hidden',
                  clip: 'rect(0, 0, 0, 0)',
                  whiteSpace: 'nowrap',
                  borderWidth: 0,
                })}
              >
                Patient-linked handover recording setup and consent controls.
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
                on('click', () => close()),
              ]}
            >
              <CloseIcon />
            </button>

            <div
              mix={css({
                paddingLeft: '1.25rem',
                paddingRight: '1.25rem',
                paddingBottom: '1.25rem',
                '@media (min-width: 40rem)': { paddingLeft: '1.5rem', paddingRight: '1.5rem', paddingBottom: '1.5rem' },
              })}
            >
              <NewHandoverForm
                action={handle.props.action}
                uploadAction={handle.props.uploadAction ?? handle.props.action}
                csrfToken={handle.props.csrfToken}
                mode="shift"
                shifts={[handle.props.shift]}
                defaultDepartment={handle.props.shift.department ?? handle.props.defaultDepartment}
                defaultParticipants={handle.props.defaultParticipants}
                defaultShiftId={handle.props.shift.id}
                defaultDirection={handle.props.direction}
                linkedPatient={{
                  key: handle.props.patient.key,
                  displayName: handle.props.patient.displayName,
                  location: handle.props.patient.location,
                  direction: handle.props.direction,
                }}
                formId={formId}
                presentation="dialog"
              />
            </div>
          </dialog>
        ) : null}
      </>
    )
  },
)

function directionIcon(direction: Direction, patientCard: boolean) {
  let styles = {
    ...(patientCard ? { width: '0.875rem', height: '0.875rem' } : { width: '1rem', height: '1rem' }),
  } satisfies Parameters<typeof css>[0]
  if (direction === 'outgoing') return <OutgoingIcon styles={styles} />
  if (direction === 'intra-shift') return <IntraShiftIcon styles={styles} />
  return <IncomingIcon styles={styles} />
}

function IncomingIcon(handle: Handle<{ styles: Parameters<typeof css>[0] }>) {
  return () => (
    <svg
      data-icon="inline-start"
      viewBox="0 0 24 24"
      aria-hidden="true"
      mix={css(handle.props.styles)}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M17 7 7 17" />
      <path d="M17 17H7V7" />
    </svg>
  )
}
function IntraShiftIcon(handle: Handle<{ styles: Parameters<typeof css>[0] }>) {
  return () => (
    <svg
      data-icon="inline-start"
      viewBox="0 0 24 24"
      aria-hidden="true"
      mix={css(handle.props.styles)}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="m2 9 3-3 3 3" />
      <path d="M13 18H7a2 2 0 0 1-2-2V6" />
      <path d="m22 15-3 3-3-3" />
      <path d="M11 6h6a2 2 0 0 1 2 2v10" />
    </svg>
  )
}
function OutgoingIcon(handle: Handle<{ styles: Parameters<typeof css>[0] }>) {
  return () => (
    <svg
      data-icon="inline-start"
      viewBox="0 0 24 24"
      aria-hidden="true"
      mix={css(handle.props.styles)}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
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

const patientPrimaryActionStyles = {
  display: 'inline-flex',
  height: '2rem',
  flexShrink: 0,
  cursor: 'pointer',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.375rem',
  borderRadius: '9999px',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'transparent',
  backgroundColor: 'var(--primary)',
  paddingLeft: '0.625rem',
  paddingRight: '0.625rem',
  fontSize: '.875rem',
  lineHeight: 1.4285714285714286,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  color: 'var(--primary-foreground)',
  transitionProperty:
    'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  '@media (hover: hover)': { '&:hover': { backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)' } },
} satisfies Parameters<typeof css>[0]
const patientSecondaryActionStyles = {
  display: 'inline-flex',
  height: '2rem',
  flexShrink: 0,
  cursor: 'pointer',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.375rem',
  borderRadius: '9999px',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'var(--border)',
  backgroundColor: 'var(--background)',
  paddingLeft: '0.625rem',
  paddingRight: '0.625rem',
  fontSize: '.875rem',
  lineHeight: 1.4285714285714286,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  color: 'var(--foreground)',
  transitionProperty:
    'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  '@media (hover: hover)': { '&:hover': { backgroundColor: 'var(--muted)' } },
} satisfies Parameters<typeof css>[0]
const patientCardActionStyles = {
  display: 'inline-flex',
  minHeight: '2.5rem',
  flex: '1',
  cursor: 'pointer',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.25rem',
  borderRadius: '9999px',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'transparent',
  backgroundColor: 'var(--primary)',
  paddingLeft: '0.625rem',
  paddingRight: '0.625rem',
  fontSize: '0.8rem',
  fontWeight: 500,
  whiteSpace: 'nowrap',
  color: 'var(--primary-foreground)',
  transitionProperty:
    'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  '@media (hover: hover)': { '&:hover': { backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)' } },
  '@media (min-width: 40rem)': { flex: 'none' },
} satisfies Parameters<typeof css>[0]
