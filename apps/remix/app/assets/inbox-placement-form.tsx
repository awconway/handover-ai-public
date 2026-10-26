import { clientEntry, css, on, ref, type Handle, type SerializableProps } from 'remix/component'
import { onSelectChange } from '@remix-run/ui/select'

import { Option, Select } from './form-select.tsx'

interface InboxPlacementFormProps extends SerializableProps {
  action: string
  assignmentTitle: string
  assignedBy: string
  sourceLabel: string
  csrfToken?: string
  shifts: Array<{ id: string; title: string; department?: string }>
}

/** A progressively isolated picker; the mutation itself remains a normal form POST. */
export const InboxPlacementForm = clientEntry(
  import.meta.url + '#InboxPlacementForm',
  function InboxPlacementForm(handle: Handle<InboxPlacementFormProps>) {
    let open = false
    let shiftId = handle.props.shifts[0]?.id ?? ''
    let pending = false
    let dialog: HTMLDialogElement | undefined

    function close() {
      if (pending) return
      if (dialog?.open) dialog.close()
      open = false
      handle.update()
    }

    return () => {
      let selected = handle.props.shifts.find((shift) => shift.id === shiftId)
      return (
        <>
          <button
            type="button"

            disabled={!handle.props.shifts.length}
            aria-haspopup="dialog"
            mix={[
              css(primaryButtonStyles),
              on('click', async () => {
                open = true
                let signal = await handle.update()
                if (!signal.aborted && dialog && !dialog.open) dialog.showModal()
              }),
            ]}
          >
            <InboxIcon />
            Place in shift
          </button>

          {open ? (
            <dialog
              aria-labelledby="place-handover-title"
              aria-describedby="place-handover-description"
              mix={[
                css({
                  margin: 'auto',
                  width: 'calc(100% - 2rem)',
                  maxWidth: '42rem',
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
                  <div>
                    <h2
                      id="place-handover-title"
                      mix={css({ fontFamily: 'var(--font-sans)', fontSize: '1rem', lineHeight: 1, fontWeight: 500 })}
                    >
                      Place received handover
                    </h2>
                    <p
                      id="place-handover-description"
                      mix={css({
                        marginTop: '0.5rem',
                        fontSize: '.875rem',
                        lineHeight: 1.4285714285714286,
                        color: 'var(--muted-foreground)',
                      })}
                    >
                      Choose which shift should receive this handover.
                    </p>
                  </div>
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
                  data-workflow="place-handover"
                  data-study-task="task-place-handover"
                  mix={[
                    css({ marginTop: '1.5rem', display: 'grid', gap: '1.25rem' }),
                    on('submit', () => {
                      pending = true
                      handle.update()
                    }),
                  ]}
                >
                  {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
                  <div
                    mix={css({
                      borderRadius: '18px',
                      borderWidth: '1px',
                      borderStyle: 'solid',
                      borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                      backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 70%, transparent)',
                      padding: '1rem',
                    })}
                  >
                    <div
                      mix={css({
                        fontSize: '11px',
                        fontWeight: 500,
                        textTransform: 'uppercase',
                        letterSpacing: '0.16em',
                        color: 'var(--color-slate-500)',
                      })}
                    >
                      Receiving handover
                    </div>
                    <div mix={css({ marginTop: '0.5rem', fontWeight: 500, color: 'var(--color-slate-950)' })}>
                      {handle.props.assignmentTitle}
                    </div>
                    <div
                      mix={css({
                        marginTop: '0.25rem',
                        fontSize: '.875rem',
                        lineHeight: '1.5rem',
                        color: 'var(--color-slate-600)',
                      })}
                    >
                      From {handle.props.assignedBy} · {handle.props.sourceLabel}
                    </div>
                  </div>
                  <div mix={css({ display: 'flex', width: '100%', flexDirection: 'column', gap: '0.5rem' })}>
                    <label
                      mix={css({
                        display: 'flex',
                        width: 'fit-content',
                        alignItems: 'center',
                        gap: '0.5rem',
                        fontSize: '.875rem',
                        lineHeight: 1,
                        fontWeight: 500,
                      })}
                      htmlFor="place-handover-shift"
                    >
                      Receiving shift
                    </label>
                    <Select
                      id="place-handover-shift"
                      name="shiftId"
                      defaultLabel={selected ? `${selected.title} · ${selected.department ?? ''}` : 'Choose a shift'}
                      defaultValue={shiftId}
                      mix={[
                        css(selectStyles),
                        onSelectChange((event) => {
                          shiftId = event.value ?? ''
                          handle.update()
                        }),
                      ]}
                    >
                      {handle.props.shifts.map((shift) => (
                        <Option key={shift.id} value={shift.id} label={`${shift.title} · ${shift.department ?? ''}`}>
                          {shift.title} · {shift.department ?? ''}
                        </Option>
                      ))}
                    </Select>
                    <p mix={css({ fontSize: '.875rem', lineHeight: '1.5rem', color: 'var(--color-slate-500)' })}>
                      Once placed, the handover will appear on that shift board and remain linked back to its source
                      shift.
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
                    <button type="button" disabled={pending} mix={[css(dialogOutlineButtonStyles), on('click', close)]}>
                      Cancel
                    </button>
                    <button type="submit" disabled={pending || !shiftId} mix={css(dialogPrimaryButtonStyles)}>
                      <CheckIcon />
                      {pending ? 'Placing handover' : 'Place in shift'}
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

function InboxIcon() {
  return () => (
    <svg
      data-icon="inline-start"
      viewBox="0 0 24 24"
      aria-hidden="true"
      mix={css({ width: '1rem', height: '1rem' })}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M4 11h16M4 11l2-7h12l2 7v9H4v-9Z" />
      <path d="M4 15h4l2 3h4l2-3h4" />
    </svg>
  )
}

function CheckIcon() {
  return () => (
    <svg
      data-icon="inline-start"
      viewBox="0 0 24 24"
      aria-hidden="true"
      mix={css({ width: '1rem', height: '1rem' })}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
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

const buttonBaseStyles = {
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
  backgroundClip: 'padding-box',
  paddingLeft: '0.625rem',
  paddingRight: '0.625rem',
  fontSize: '.875rem',
  lineHeight: 1.4285714285714286,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  transitionProperty: 'all',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  outlineStyle: 'none',
  userSelect: 'none',
  '&:focus-visible': {
    borderColor: 'var(--ring)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)',
  },
  '&:active': { translate: '0 1px' },
  '&:disabled': { pointerEvents: 'none', cursor: 'not-allowed', opacity: 0.5 },
} satisfies Parameters<typeof css>[0]
const primaryButtonStyles = {
  ...buttonBaseStyles,
  backgroundColor: 'var(--primary)',
  color: 'var(--primary-foreground)',
  '@media (hover: hover)': { '&:hover': { backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)' } },
} satisfies Parameters<typeof css>[0]
const dialogButtonBaseStyles = {
  display: 'inline-flex',
  height: '2rem',
  flexShrink: 0,
  cursor: 'pointer',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.375rem',
  borderRadius: 'var(--radius)',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'transparent',
  backgroundClip: 'padding-box',
  paddingLeft: '0.625rem',
  paddingRight: '0.625rem',
  fontSize: '.875rem',
  lineHeight: 1.4285714285714286,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  transitionProperty: 'all',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  outlineStyle: 'none',
  userSelect: 'none',
  '&:focus-visible': {
    borderColor: 'var(--ring)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)',
  },
  '&:active': { translate: '0 1px' },
  '&:disabled': { pointerEvents: 'none', cursor: 'not-allowed', opacity: 0.5 },
} satisfies Parameters<typeof css>[0]
const dialogPrimaryButtonStyles = {
  ...dialogButtonBaseStyles,
  backgroundColor: 'var(--primary)',
  color: 'var(--primary-foreground)',
  '@media (hover: hover)': { '&:hover': { backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)' } },
} satisfies Parameters<typeof css>[0]
const dialogOutlineButtonStyles = {
  ...dialogButtonBaseStyles,
  backgroundColor: 'var(--background)',
  color: 'var(--foreground)',
  '@media (hover: hover)': { '&:hover': { backgroundColor: 'var(--muted)' } },
} satisfies Parameters<typeof css>[0]

// FormSelect owns the shared geometry; this form supplies the theme and chevron.
const selectStyles = {
  transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  outlineStyle: 'none',
  background: 'transparent',
  border: '1px solid var(--input)',
  boxShadow: 'none',
  color: 'inherit',
  font: 'inherit',
  fontSize: '14px',
  padding: '4px 10px',
  textShadow: 'none',
  '&::after': {
    content: '""',
    width: '7px',
    height: '7px',
    marginLeft: 'auto',
    marginRight: '2px',
    borderRight: '1.5px solid currentColor',
    borderBottom: '1.5px solid currentColor',
    transform: 'translateY(-2px) rotate(45deg)',
    flex: 'none',
  },
  '&:hover, &:focus-visible, &[aria-expanded="true"]': { background: 'transparent', color: 'inherit' },
  '&:focus-visible, &[aria-expanded="true"]': {
    boxShadow: '0 0 0 3px color-mix(in srgb, var(--ring) 50%, transparent)',
    outline: 0,
  },
} satisfies Parameters<typeof css>[0]
