import { css, clientEntry, on, ref, type Handle, type SerializableProps } from 'remix/component'

interface DeleteShiftFormProps extends SerializableProps {
  action: string
  shiftTitle: string
  csrfToken?: string
}

/** A native Remix confirmation island around the ordinary destructive POST. */
export const DeleteShiftForm = clientEntry(
  import.meta.url + '#DeleteShiftForm',
  function DeleteShiftForm(handle: Handle<DeleteShiftFormProps>) {
    let open = false
    let pending = false
    let dialog: HTMLDialogElement | undefined

    function close() {
      if (pending) return
      if (dialog?.open) dialog.close()
      open = false
      handle.update()
    }

    return () => (
      <>
        <button
          type="button"
          aria-haspopup="dialog"
          mix={[
            css({
              display: 'inline-flex',
              height: '2rem',
              width: '100%',
              alignItems: 'center',
              justifyContent: 'flex-start',
              gap: '0.375rem',
              borderRadius: '18px',
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: 'var(--border)',
              backgroundColor: 'var(--background)',
              paddingLeft: '0.625rem',
              paddingRight: '0.625rem',
              fontSize: '.875rem',
              lineHeight: 1.4285714285714286,
              fontWeight: 500,
              color: 'var(--foreground)',
              transitionProperty:
                'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
              transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
              transitionDuration: '150ms',
              '@media (hover: hover)': { '&:hover': { backgroundColor: 'var(--muted)' } },
            }),
            on('click', async () => {
              open = true
              let signal = await handle.update()
              if (!signal.aborted && dialog && !dialog.open) dialog.showModal()
            }),
          ]}
        >
          <TrashIcon />
          Delete shift
        </button>

        {open ? (
          <dialog
            aria-labelledby="delete-shift-title"
            aria-describedby="delete-shift-description"
            aria-busy={pending || undefined}
            mix={[
              css({
                margin: 'auto',
                display: 'grid',
                width: 'calc(100% - 2rem)',
                maxWidth: '24rem',
                gap: '1rem',
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
            <div mix={css({ display: 'flex', flexDirection: 'column', gap: '0.5rem' })}>
              <h2
                id="delete-shift-title"
                mix={css({ fontFamily: 'var(--font-sans)', fontSize: '1rem', lineHeight: 1, fontWeight: 500 })}
              >
                Delete shift?
              </h2>
              <p
                id="delete-shift-description"
                mix={css({ fontSize: '.875rem', lineHeight: 1.4285714285714286, color: 'var(--muted-foreground)' })}
              >
                Delete the shift "{handle.props.shiftTitle}" and all handovers attached to it. This cannot be undone.
              </p>
            </div>
            {!pending ? (
              <button
                type="button"
                aria-label="Close"
                mix={[
                  css({
                    position: 'absolute',
                    top: '0.5rem',
                    right: '0.5rem',
                    display: 'inline-flex',
                    width: '1.75rem',
                    height: '1.75rem',
                    flexShrink: 0,
                    cursor: 'pointer',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 'min(var(--radius-md),12px)',
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    borderColor: 'transparent',
                    color: 'var(--foreground)',
                    transitionProperty: 'all',
                    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                    transitionDuration: '150ms',
                    outlineStyle: 'none',
                    userSelect: 'none',
                    '@media (hover: hover)': { '&:hover': { backgroundColor: 'var(--muted)' } },
                    '&:focus-visible': {
                      borderColor: 'var(--ring)',
                      boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)',
                    },
                  }),
                  on('click', close),
                ]}
              >
                <CloseIcon />
              </button>
            ) : null}
            <form
              method="post"
              action={handle.props.action}
              mix={[
                css({
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
                }),
                on('submit', () => {
                  pending = true
                  handle.update()
                }),
              ]}
            >
              {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
              <button type="button" disabled={pending} mix={[css(outlineButtonStyles), on('click', close)]}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending}
                mix={css({
                  ...buttonBaseStyles,
                  backgroundColor: 'color-mix(in oklab, var(--destructive) 10%, transparent)',
                  color: 'var(--destructive)',
                  '@media (hover: hover)': {
                    '&:hover': { backgroundColor: 'color-mix(in oklab, var(--destructive) 20%, transparent)' },
                  },
                })}
              >
                {pending ? 'Deleting' : 'Confirm delete shift'}
              </button>
            </form>
          </dialog>
        ) : null}
      </>
    )
  },
)

function TrashIcon() {
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

const buttonBaseStyles = {
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
const outlineButtonStyles = {
  ...buttonBaseStyles,
  backgroundColor: 'var(--background)',
  color: 'var(--foreground)',
  '@media (hover: hover)': { '&:hover': { backgroundColor: 'var(--muted)' } },
} satisfies Parameters<typeof css>[0]
