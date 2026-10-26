import { css, link, type Handle, type RemixNode } from 'remix/component'

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger'
type Styles = Parameters<typeof css>[0]

export function Button(handle: Handle<{ children?: RemixNode; href?: string; frameTarget?: string; resetScroll?: boolean; type?: 'button' | 'submit'; name?: string; value?: string; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; disabled?: boolean; ariaLabel?: string; dataTestId?: string; analyticsId?: string; styles?: Styles }>) {
  return () => {
    let p = handle.props
    let variant = p.variant === 'primary' ? buttonPrimaryStyle : p.variant === 'danger' ? buttonDangerStyle : p.variant === 'ghost' ? buttonGhostStyle : buttonSecondaryStyle
    let { ['&:focus-visible']: focusVisible = focusStyle, ...overrides } = p.styles ?? {}
    // One rule keeps variants and caller overrides in the same cascade layer.
    let styles = css({ ...buttonBaseStyle, ...variant, ...overrides, '&:focus-visible': focusVisible })
    return p.href
      ? p.frameTarget
        ? <a href={p.href} mix={[styles, link(p.href, { target: p.frameTarget, resetScroll: p.resetScroll })]} aria-label={p.ariaLabel} data-testid={p.dataTestId} data-analytics-id={p.analyticsId}>{p.children}</a>
        : <a href={p.href} mix={styles} aria-label={p.ariaLabel} data-testid={p.dataTestId} data-analytics-id={p.analyticsId}>{p.children}</a>
      : <button type={p.type ?? 'button'} name={p.name} value={p.value} disabled={p.disabled} aria-label={p.ariaLabel} data-testid={p.dataTestId} data-analytics-id={p.analyticsId} mix={styles}>{p.children}</button>
  }
}

export function Badge(handle: Handle<{ children?: RemixNode; tone?: Tone; styles?: Styles }>) {
  return () => {
    let tone = handle.props.tone ?? 'neutral'
    let { ['&:focus-visible']: focusVisible = focusStyle, ...overrides } = handle.props.styles ?? {}
    return <span data-tone={tone} mix={css({ ...badgeBaseStyle, ...badgeToneStyles[tone], ...overrides, '&:focus-visible': focusVisible })}>{handle.props.children}</span>
  }
}

export function Alert(handle: Handle<{ children?: RemixNode; title: string; tone?: Tone }>) {
  return () => <div role={handle.props.tone === 'danger' ? 'alert' : 'status'} data-tone={handle.props.tone ?? 'neutral'} mix={alertStyle}><strong>{handle.props.title}</strong>{handle.props.children ? <div>{handle.props.children}</div> : null}</div>
}

export function Spinner(handle: Handle<{ label?: string }>) {
  return () => <span role="status" mix={spinnerWrap}><span aria-hidden="true" mix={spinnerStyle}></span>{handle.props.label ? <span>{handle.props.label}</span> : <span mix={visuallyHidden}>Loading</span>}</span>
}

const visuallyHidden = css({ position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px', overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 })

const focusStyle: Styles = { borderColor: 'var(--ring)', boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)' }
const buttonBaseStyle: Styles = {
  display: 'inline-flex', height: '2rem', flexShrink: 0, cursor: 'pointer', alignItems: 'center', justifyContent: 'center',
  gap: '.375rem', borderRadius: 'var(--radius)', border: '1px solid transparent', backgroundClip: 'padding-box',
  paddingInline: '.625rem', fontSize: '.875rem', lineHeight: '1.42857143', fontWeight: 500, whiteSpace: 'nowrap',
  transition: 'all 150ms cubic-bezier(.4, 0, .2, 1)', outlineStyle: 'none', WebkitUserSelect: 'none', userSelect: 'none',
  '&:active:not([aria-haspopup])': { translate: '0 1px' },
  '&:disabled': { pointerEvents: 'none', cursor: 'not-allowed', opacity: .5 },
}
const buttonPrimaryStyle: Styles = { backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)', '&:hover': { '@media (hover: hover)': { backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)' } } }
const buttonSecondaryStyle: Styles = { backgroundColor: 'var(--background)', color: 'var(--foreground)', '&:hover': { '@media (hover: hover)': { backgroundColor: 'var(--muted)', color: 'var(--foreground)' } } }
const buttonGhostStyle: Styles = { color: 'var(--foreground)', '&:hover': { '@media (hover: hover)': { backgroundColor: 'var(--muted)', color: 'var(--foreground)' } } }
const buttonDangerStyle: Styles = {
  backgroundColor: 'color-mix(in oklab, var(--destructive) 10%, transparent)', color: 'var(--destructive)',
  '&:hover': { '@media (hover: hover)': { backgroundColor: 'color-mix(in oklab, var(--destructive) 20%, transparent)' } },
}
const badgeBaseStyle: Styles = {
  display: 'inline-flex', height: '1.25rem', width: 'fit-content', flexShrink: 0, alignItems: 'center', justifyContent: 'center',
  gap: '.25rem', overflow: 'hidden', borderRadius: 'calc(var(--radius) * 2.6)', border: '1px solid transparent', padding: '.125rem .5rem',
  fontSize: '.75rem', lineHeight: '1.33333333', fontWeight: 500, whiteSpace: 'nowrap', transition: 'all 150ms cubic-bezier(.4, 0, .2, 1)',
}
const badgeToneStyles: Record<Tone, Styles> = {
  neutral: { backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 6%, transparent)', color: 'var(--color-slate-700)', boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-950) 10%, transparent)' },
  primary: { backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)', color: 'var(--primary)', boxShadow: '0 0 0 1px color-mix(in oklab, var(--primary) 15%, transparent)' },
  success: { backgroundColor: 'color-mix(in oklab, var(--color-emerald-100) 80%, transparent)', color: 'var(--color-emerald-800)', boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-emerald-200) 80%, transparent)' },
  warning: { backgroundColor: 'color-mix(in oklab, var(--color-amber-100) 85%, transparent)', color: 'var(--color-amber-800)', boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-amber-200) 70%, transparent)' },
  danger: { backgroundColor: 'color-mix(in oklab, var(--destructive) 10%, transparent)', color: 'var(--destructive)', boxShadow: '0 0 0 1px color-mix(in oklab, var(--destructive) 15%, transparent)' },
}
const alertStyle = css({ display: 'grid', gap: '5px', padding: '14px 16px', borderRadius: '16px', border: '1px solid #d7e0e8', background: '#f4f7fa', color: '#445466', fontSize: '14px', '&[data-tone=success]': { background: '#edf8f3', borderColor: '#c9e7d9', color: '#21674e' }, '&[data-tone=warning]': { background: '#fff8e8', borderColor: '#f2dfb2', color: '#805612' }, '&[data-tone=danger]': { background: '#fff0f1', borderColor: '#f1c9cd', color: '#942f3b' } })
const spinnerWrap = css({ display: 'inline-flex', alignItems: 'center', gap: '8px' })
const spinnerStyle = css({ width: '16px', height: '16px', display: 'inline-block', borderRadius: '50%', border: '2px solid currentColor', borderRightColor: 'transparent', animation: 'spin .7s linear infinite', '@media (prefers-reduced-motion: reduce)': { animation: 'none', borderRightColor: 'currentColor' } })
