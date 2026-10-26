import { css, clientEntry, on, type Handle, type SerializableProps } from 'remix/component'
import * as popover from '@remix-run/ui/popover'

interface NoiseMetricProps extends SerializableProps {
  label: string
  description: string
  value: string
}

/** React-parity metric help, implemented with Remix's native popover mixins. */
export const NoiseMetric = clientEntry(
  import.meta.url + '#NoiseMetric',
  function NoiseMetric(handle: Handle<NoiseMetricProps>) {
    let open = false

    function updateOpen(nextOpen: boolean) {
      open = nextOpen
      handle.update()
    }

    return () => (
      <div>
        <div
          mix={css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.375rem',
            fontSize: '11px',
            fontWeight: 600,
            letterSpacing: '0.14em',
            color: 'var(--color-slate-500)',
            textTransform: 'uppercase',
          })}
        >
          <span>{handle.props.label}</span>
          <popover.Context>
            <button
              type="button"
              aria-label={`About ${handle.props.label}`}
              aria-haspopup="dialog"
              aria-expanded={open}
              mix={[
                css({
                  display: 'inline-flex',
                  width: '1.25rem',
                  height: '1.25rem',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '9999px',
                  color: 'var(--color-slate-400)',
                  transitionProperty:
                    'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                  transitionDuration: '150ms',
                  '@media (hover: hover)': {
                    '&:hover': {
                      backgroundColor: 'color-mix(in oklab, var(--color-slate-200) 70%, transparent)',
                      color: 'var(--color-slate-700)',
                    },
                  },
                  '&:focus-visible': { outlineStyle: 'none', boxShadow: '0 0 0 2px var(--color-slate-300)' },
                }),
                popover.anchor({ placement: 'bottom-start' }),
                popover.focusOnHide(),
                on('click', () => updateOpen(!open)),
              ]}
            >
              <InfoIcon />
            </button>
            <section
              role="dialog"
              aria-label={handle.props.label}
              mix={[
                css({
                  zIndex: 50,
                  width: 'min(18rem,calc(100vw - 2rem))',
                  borderRadius: 'calc(var(--radius) * 1.4)',
                  borderWidth: '1px',
                  borderStyle: 'solid',
                  borderColor: 'var(--color-slate-200)',
                  backgroundColor: '#fff',
                  padding: '1rem',
                  color: 'var(--color-slate-950)',
                  boxShadow: '0 18px 45px rgba(15,23,42,0.18)',
                }),
                popover.surface({
                  open,
                  closeOnAnchorClick: false,
                  stopOutsideClickPropagation: false,
                  onHide() {
                    updateOpen(false)
                  },
                }),
              ]}
            >
              <h3
                mix={css({
                  fontSize: '.875rem',
                  lineHeight: 1.4285714285714286,
                  fontWeight: 600,
                  color: 'var(--color-slate-950)',
                })}
              >
                {handle.props.label}
              </h3>
              <p
                mix={css({
                  marginTop: '0.375rem',
                  fontSize: '.875rem',
                  lineHeight: '1.5rem',
                  color: 'var(--color-slate-600)',
                })}
              >
                {handle.props.description}
              </p>
            </section>
          </popover.Context>
        </div>
        <div mix={css({ marginTop: '0.25rem', fontWeight: 500, color: 'var(--color-slate-950)' })}>
          {handle.props.value}
        </div>
      </div>
    )
  },
)

function InfoIcon() {
  return () => (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      mix={css({ width: '0.875rem', height: '0.875rem' })}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  )
}
