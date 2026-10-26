import { css, clientEntry, on, ref, type Handle, type SerializableProps } from 'remix/component'

interface DeleteHandoverDialogProps extends SerializableProps {
  action: string
  handoverTitle: string
  csrfToken?: string
}

/** Keeps the ordinary destructive POST behind the confirmation dialog used by the React app. */
export const DeleteHandoverDialog = clientEntry(
  import.meta.url + '#DeleteHandoverDialog',
  function DeleteHandoverDialog(handle: Handle<DeleteHandoverDialogProps>) {
    let open = false
    let titleId = `delete-handover-title-${handle.id}`
    let descriptionId = `delete-handover-description-${handle.id}`
    let dialog: HTMLDialogElement | undefined

    function close() {
      if (dialog?.open) dialog.close()
      open = false
      handle.update()
    }

    return () => (
      <>
        <button
          type="button"
          aria-label="Delete handover"
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid="review-action-delete"
          data-analytics-id="handover-delete-open"
          mix={[
            css({
              gridColumnStart: '3',
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
                '@media (hover: hover)': { '&:hover': { backgroundColor: 'var(--muted)', color: 'var(--foreground)' } },
                boxShadow: 'none',
              },
              boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-200) 70%, transparent)',
            }),
            on('click', async () => {
              open = true
              let signal = await handle.update()
              if (!signal.aborted && dialog && !dialog.open) dialog.showModal()
            }),
          ]}
        >
          <TrashIcon />
          <span
            data-testid="review-action-delete-mobile-label"
            mix={css({ '@media (min-width: 48rem)': { display: 'none' } })}
          >
            Delete
          </span>
          <span
            data-testid="review-action-delete-desktop-label"
            mix={css({ display: 'none', '@media (min-width: 48rem)': { display: 'inline' } })}
          >
            Delete handover
          </span>
        </button>

        {open ? (
          <dialog
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
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
                id={titleId}
                mix={css({ fontFamily: 'var(--font-sans)', fontSize: '1rem', lineHeight: 1, fontWeight: 500 })}
              >
                Delete handover?
              </h2>
              <p
                id={descriptionId}
                mix={css({ fontSize: '.875rem', lineHeight: 1.4285714285714286, color: 'var(--muted-foreground)' })}
              >
                Delete "{handle.props.handoverTitle}" permanently. This cannot be undone.
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
                on('click', close),
              ]}
            >
              <CloseIcon />
            </button>

            <form
              method="post"
              action={handle.props.action}
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
              data-workflow="delete-handover"
            >
              {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
              <button type="button" mix={[css(outlineButtonStyles), on('click', close)]}>
                Cancel
              </button>
              <button type="submit" mix={css(destructiveButtonStyles)}>
                Confirm delete handover
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
      mix={css({ width: '1.25rem', height: '1.25rem', '@media (min-width: 48rem)': { width: '1rem', height: '1rem' } })}
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
const outlineButtonStyles = {
  ...buttonBaseStyles,
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'var(--border)',
  backgroundColor: 'var(--background)',
  color: 'var(--foreground)',
  '@media (hover: hover)': { '&:hover': { backgroundColor: 'var(--muted)' } },
} satisfies Parameters<typeof css>[0]
const destructiveButtonStyles = {
  ...buttonBaseStyles,
  backgroundColor: 'var(--destructive)',
  color: '#fff',
  '@media (hover: hover)': {
    '&:hover': { backgroundColor: 'color-mix(in oklab, var(--destructive) 90%, transparent)' },
  },
} satisfies Parameters<typeof css>[0]
