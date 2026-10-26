import { css, type Handle } from 'remix/component'

import type { LocalFirstProcessingPolicy, PrivacyMode } from '../data/local-first-processing.ts'
import { Alert, Badge, Button } from './primitives.tsx'

type PrivacySettingsPageProps = {
  action: string
  csrfToken?: string
  homeHref: string
  policy: LocalFirstProcessingPolicy
  userEnabled: boolean
  effectiveMode: PrivacyMode
  editable: boolean
  notice?: string
  error?: string
}

const policyCopy: Record<LocalFirstProcessingPolicy, { label: string; description: string }> = {
  disabled: {
    label: 'Disabled by deployment',
    description: 'This deployment sends locally transcribed text to cloud analysis without deidentification.',
  },
  optional: {
    label: 'Your choice',
    description: 'You can choose to deidentify transcripts before cloud analysis for audio recorded from this profile.',
  },
  required: {
    label: 'Required by deployment',
    description: 'This deployment requires transcript deidentification before cloud analysis.',
  },
}

export function PrivacySettingsPage(handle: Handle<PrivacySettingsPageProps>) {
  return () => {
    let props = handle.props
    let copy = policyCopy[props.policy]
    let localFirst = props.effectiveMode === 'local-first'

    return <main id="main-content" tabIndex={-1} mix={css({
      minHeight: '100vh',
      backgroundColor: 'var(--color-slate-50)',
      paddingInline: '1rem',
      paddingBlock: '2rem',
      '@media (width >= 40rem)': {
        paddingInline: '1.5rem',
        paddingBlock: '3rem'
      }
    })}>
      <div mix={css({ marginInline: "auto", display: "flex", width: "100%", maxWidth: "42rem", flexDirection: "column", gap: "1.5rem" })}>
        <div>
          <Button href={props.homeHref} variant="ghost" styles={{ marginLeft: "-0.5rem", borderRadius: "var(--radius)" }}>Back to workflows</Button>
        </div>

        <header mix={css({ ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "0.75rem" } })}>
          <Badge tone={localFirst ? 'success' : 'neutral'}>{localFirst ? 'Deidentification on' : 'Deidentification off'}</Badge>
          <h1 mix={css({
            fontFamily: '\'Geist Variable\', sans-serif',
            fontSize: '1.875rem',
            lineHeight: '1.2',
            fontWeight: '600',
            letterSpacing: '-0.025em',
            color: 'var(--color-slate-950)',
            '@media (width >= 40rem)': {
              fontSize: '2.25rem',
              lineHeight: '1.11111111'
            }
          })}>Audio privacy</h1>
          <p mix={css({ maxWidth: "36rem", fontSize: "1rem", lineHeight: "1.75rem", color: "var(--color-slate-600)" })}>
            Audio is always transcribed locally. Choose whether to deidentify transcripts before the app uses cloud-hosted language models for analysis.
          </p>
        </header>

        {props.notice ? <Alert title="Preference saved" tone="success">{props.notice}</Alert> : null}
        {props.error ? <Alert title="Could not save the preference" tone="danger">{props.error}</Alert> : null}

        <section aria-labelledby="local-first-heading" mix={css({
          borderRadius: 'calc(var(--radius) * 2.2)',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'var(--color-slate-200)',
          backgroundColor: 'var(--color-white)',
          padding: '1.25rem',
          boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
          '@media (width >= 40rem)': {
            padding: '1.75rem'
          }
        })}>
          <div mix={css({ marginBottom: "1.5rem", display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" })}>
            <div mix={css({ ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "0.25rem" } })}>
              <h2 id="local-first-heading" mix={css({ fontSize: "1.125rem", lineHeight: "1.55555556", fontWeight: "600", color: "var(--color-slate-950)" })}>Transcript deidentification</h2>
              <p mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>{copy.description}</p>
            </div>
            <Badge tone={props.policy === 'required' ? 'success' : props.policy === 'disabled' ? 'warning' : 'primary'}>{copy.label}</Badge>
          </div>

          <form method="post" action={props.action} mix={css({ ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "1.5rem" } })}>
            {props.csrfToken ? <input type="hidden" name="_csrf" value={props.csrfToken} /> : null}
            <div mix={css({
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '1.25rem',
              borderRadius: 'calc(var(--radius) * 1.8)',
              borderStyle: 'solid',
              borderWidth: '1px',
              borderColor: 'var(--color-slate-200)',
              backgroundColor: 'var(--color-slate-50)',
              paddingInline: '1rem',
              paddingBlock: '1rem'
            })}>
              <label htmlFor="local-first-processing-enabled" mix={css({ minWidth: "0", cursor: "pointer" })}>
                <span mix={css({ display: "block", fontWeight: "500", color: "var(--color-slate-950)" })}>Deidentify before cloud analysis</span>
                <span id="local-first-help" mix={css({ marginTop: "0.25rem", display: "block", fontSize: "0.875rem", lineHeight: "1.25rem", color: "var(--color-slate-600)" })}>
                  Changes apply to future jobs. Jobs already created keep their selected deidentification preference.
                </span>
              </label>
              <input
                id="local-first-processing-enabled"
                name="enabled"
                type="checkbox"
                role="switch"
                value="true"
                checked={localFirst}
                disabled={!props.editable}
                aria-describedby="local-first-help"
                mix={css({
                  height: '1.5rem',
                  width: '2.75rem',
                  flexShrink: '0',
                  cursor: 'pointer',
                  accentColor: 'var(--primary)',
                  '&:disabled': {
                    cursor: 'not-allowed',
                    opacity: '60%'
                  }
                })}
              />
            </div>
            <Button type="submit" variant="primary" disabled={!props.editable}>Save privacy preference</Button>
          </form>
        </section>

        <p mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-500)" })}>
          This preference controls which transcript details are sent for cloud analysis. It does not hide information in the app itself.
        </p>
      </div>
    </main>
  }
}
