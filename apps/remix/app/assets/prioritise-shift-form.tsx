import { css, clientEntry, type Handle, type SerializableProps } from 'remix/component'

import { enhanceFrameMutation } from './frame-mutation.ts'

interface PrioritiseShiftFormProps extends SerializableProps {
  action: string
  csrfToken?: string
  disabled?: boolean
}

/** React's pending affordance around an ordinary native Remix form POST. */
export const PrioritiseShiftForm = clientEntry(
  import.meta.url + '#PrioritiseShiftForm',
  function PrioritiseShiftForm(handle: Handle<PrioritiseShiftFormProps>) {
    let pending = false
    let error = ''
    return () => (
      <>
        <form
          method="post"
          action={handle.props.action}
          aria-busy={pending || undefined}
          mix={enhanceFrameMutation(handle, {
            onPending(value) {
              pending = value
              if (value) error = ''
            },
            onError(message) {
              error = message
            },
            onRefreshError() {
              error = 'The shift was prioritised, but the board could not be refreshed.'
            },
          })}
        >
          {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
          <button
            type="submit"
            disabled={handle.props.disabled || pending}
            aria-busy={pending || undefined}
            mix={css({
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
              '&:disabled': { pointerEvents: 'none', opacity: 0.5 },
            })}
          >
            {pending ? <LoadingIcon /> : <PrioritiseIcon />}
            {pending ? 'Calculating priority order' : 'Prioritise'}
          </button>
        </form>
        {pending ? (
          <div
            role="status"
            mix={css({
              borderRadius: '14px',
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: 'color-mix(in oklab, var(--primary) 15%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)',
              paddingLeft: '0.75rem',
              paddingRight: '0.75rem',
              paddingTop: '0.5rem',
              paddingBottom: '0.5rem',
              fontSize: '.875rem',
              lineHeight: '1.5rem',
              color: 'var(--primary)',
            })}
          >
            Checking acuity, risk, and workflow signals before updating the board.
          </div>
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
      </>
    )
  },
)

function PrioritiseIcon() {
  return () => (
    <svg
      data-icon="inline-start"
      mix={css({ width: '1rem', height: '1rem' })}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="m16 3 4 4-4 4" />
      <path d="M20 7H4" />
      <path d="m8 21-4-4 4-4" />
      <path d="M4 17h16" />
    </svg>
  )
}
function LoadingIcon() {
  return () => (
    <svg
      data-icon="inline-start"
      mix={css({ width: '1rem', height: '1rem', animation: 'spin 1s linear infinite' })}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
    </svg>
  )
}
