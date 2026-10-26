import { css, clientEntry, on, ref, type Handle, type SerializableProps } from 'remix/component'
import * as popover from '@remix-run/ui/popover'

import { enhanceFrameMutation } from './frame-mutation.ts'

interface PrivacyFindingAllowControlProps extends SerializableProps {
  action: string
  controlId: string
  csrfToken?: string
  findingRefs: string
}

/** Compact confirmation for allowing one merged local-privacy span in cloud analysis. */
export const PrivacyFindingAllowControl = clientEntry(
  import.meta.url + '#PrivacyFindingAllowControl',
  function PrivacyFindingAllowControl(handle: Handle<PrivacyFindingAllowControlProps>) {
    let open = false
    let pending = false
    let error = ''
    let trigger: HTMLButtonElement | null = null
    let cancelButton: HTMLButtonElement | null = null

    function updateOpen(nextOpen: boolean) {
      open = nextOpen
      if (nextOpen) error = ''
      void handle.update().then((signal) => {
        if (nextOpen && !signal.aborted) cancelButton?.focus()
      })
    }

    function closeAndRestoreFocus() {
      open = false
      void handle.update().then((signal) => {
        if (!signal.aborted) trigger?.focus()
      })
    }

    let dialogId = `${handle.props.controlId}-dialog`
    let titleId = `${handle.props.controlId}-title`
    let descriptionId = `${handle.props.controlId}-description`

    return () => (
      <popover.Context>
        <button
          type="button"
          aria-label="Review allowing this tagged span in analysis"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={dialogId}
          title="Allow in analysis"
          disabled={pending}
          data-testid="allow-privacy-finding-trigger"
          mix={[
            css({
              position: 'relative',
              marginTop: '-1px',
              marginBottom: '-1px',
              marginRight: '-1px',
              display: 'inline-flex',
              width: '1.5rem',
              height: '1.5rem',
              flexShrink: 0,
              touchAction: 'manipulation',
              cursor: 'pointer',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '9999px',
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: 'color-mix(in oklab, var(--color-amber-300) 80%, transparent)',
              backgroundColor: 'var(--color-amber-50)',
              color: 'var(--color-amber-900)',
              transitionProperty:
                'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
              transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
              transitionDuration: '150ms',
              '@media (hover: hover)': {
                '&:hover': { backgroundColor: 'var(--color-amber-100)', color: 'var(--color-amber-950)' },
              },
              '&:focus-visible': {
                zIndex: 10,
                outlineStyle: 'none',
                boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 40%, transparent)',
              },
              '&:disabled': { pointerEvents: 'none', opacity: 0.5 },
            }),
            popover.anchor({ placement: 'bottom-end' }),
            popover.focusOnHide(),
            ref((node) => {
              trigger = node
            }),
            on('click', () => updateOpen(!open)),
          ]}
        >
          <CloseIcon />
        </button>
        <section
          id={dialogId}
          role="dialog"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          data-testid="allow-privacy-finding-confirmation"
          mix={[
            css({
              zIndex: 50,
              width: 'min(18rem,calc(100vw - 2rem))',
              borderRadius: 'calc(var(--radius) * 1.4)',
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: 'var(--color-amber-200)',
              backgroundColor: '#fff',
              padding: '0.75rem',
              textAlign: 'left',
              fontWeight: 400,
              letterSpacing: '0',
              whiteSpace: 'normal',
              textTransform: 'none',
              color: 'var(--color-slate-950)',
              outlineStyle: 'none',
              '&:not(:popover-open)': { display: 'none' },
              boxShadow: '0 18px 45px rgba(15,23,42,0.18)',
            }),
            popover.surface({
              open,
              closeOnAnchorClick: false,
              stopOutsideClickPropagation: false,
              onHide() {
                if (pending) return
                updateOpen(false)
              },
            }),
          ]}
        >
          <h3 id={titleId} mix={css({ fontSize: '.875rem', lineHeight: 1.4285714285714286, fontWeight: 600 })}>
            Allow in analysis?
          </h3>
          <p
            id={descriptionId}
            mix={css({
              marginTop: '0.25rem',
              fontSize: '.75rem',
              lineHeight: '1.25rem',
              color: 'var(--color-slate-600)',
            })}
          >
            This text will be included in the next cloud analysis. The exception also carries forward if this handover
            is recommenced.
          </p>
          <form
            method="post"
            action={handle.props.action}
            aria-busy={pending || undefined}
            data-workflow="allow-privacy-findings"
            data-testid="allow-privacy-findings-form"
            mix={[
              css({ marginTop: '0.75rem' }),
              enhanceFrameMutation(handle, {
                resetScroll: false,
                onPending(value) {
                  pending = value
                  if (value) error = ''
                },
                onError(message) {
                  error = message
                },
                onSuccess() {
                  open = false
                },
                onRefreshError() {
                  open = true
                  error = 'The change was saved, but the page could not be refreshed.'
                },
              }),
            ]}
          >
            {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
            <input type="hidden" name="findingRefs" value={handle.props.findingRefs} />
            {error ? (
              <div
                role="alert"
                mix={css({
                  marginBottom: '0.5rem',
                  borderRadius: 'var(--radius)',
                  borderWidth: '1px',
                  borderStyle: 'solid',
                  borderColor: 'var(--color-rose-200)',
                  backgroundColor: 'var(--color-rose-50)',
                  paddingLeft: '0.625rem',
                  paddingRight: '0.625rem',
                  paddingTop: '0.5rem',
                  paddingBottom: '0.5rem',
                  fontSize: '.75rem',
                  lineHeight: '1.25rem',
                  color: 'var(--color-rose-900)',
                })}
              >
                {error}
              </div>
            ) : null}
            <div mix={css({ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' })}>
              <button
                type="button"
                disabled={pending}
                mix={[
                  css({
                    display: 'inline-flex',
                    height: '2rem',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 'var(--radius)',
                    paddingLeft: '0.75rem',
                    paddingRight: '0.75rem',
                    fontSize: '.75rem',
                    lineHeight: 1.3333333333333333,
                    fontWeight: 600,
                    color: 'var(--color-slate-600)',
                    transitionProperty:
                      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                    transitionDuration: '150ms',
                    '@media (hover: hover)': {
                      '&:hover': { backgroundColor: 'var(--color-slate-100)', color: 'var(--color-slate-950)' },
                    },
                    '&:focus-visible': {
                      outlineStyle: 'none',
                      boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 40%, transparent)',
                    },
                    '&:disabled': { pointerEvents: 'none', opacity: 0.5 },
                  }),
                  popover.focusOnShow(),
                  ref((node) => {
                    cancelButton = node
                  }),
                  on('click', closeAndRestoreFocus),
                ]}
              >
                Cancel
              </button>
              <button
                type="submit"
                aria-label="Confirm allowing tagged text in analysis"
                disabled={pending}
                mix={css({
                  display: 'inline-flex',
                  height: '2rem',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 'var(--radius)',
                  backgroundColor: 'var(--color-amber-900)',
                  paddingLeft: '0.75rem',
                  paddingRight: '0.75rem',
                  fontSize: '.75rem',
                  lineHeight: 1.3333333333333333,
                  fontWeight: 600,
                  color: '#fff',
                  transitionProperty:
                    'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                  transitionDuration: '150ms',
                  '@media (hover: hover)': { '&:hover': { backgroundColor: 'var(--color-amber-950)' } },
                  '&:focus-visible': {
                    outlineStyle: 'none',
                    boxShadow: '0 0 0 2px #fff, 0 0 0 5px color-mix(in oklab, var(--color-amber-900) 35%, transparent)',
                  },
                  '&:disabled': { pointerEvents: 'none', opacity: 0.5 },
                })}
              >
                {pending ? 'Allowing…' : 'Allow'}
              </button>
            </div>
            {pending ? (
              <span
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
                role="status"
              >
                Allowing tagged text…
              </span>
            ) : null}
          </form>
        </section>
      </popover.Context>
    )
  },
)

function CloseIcon() {
  return () => (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      mix={css({ width: '0.75rem', height: '0.75rem' })}
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
    >
      <path d="M7 7l10 10M17 7 7 17" />
    </svg>
  )
}
