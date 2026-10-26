import { Frame, attrs, css, link, type Handle, type RemixNode } from 'remix/component'

import { AnalyticsCoordinator } from '../assets/analytics-coordinator.tsx'
import { ProcessingCoordinator } from '../assets/processing-coordinator.tsx'
import { RecordingCoordinator } from '../assets/recording-coordinator.tsx'
import { WorkspaceTitleCoordinator } from '../assets/workspace-title-coordinator.tsx'
import { Badge, Button, Spinner } from './primitives.tsx'

type RecordingConfig = {
  submitAction: string
  uploadAction?: string
  csrfToken?: string
  contextLabel?: string
  active?: boolean
  formId?: string
}

export type WorkspaceBreadcrumb = {
  label: string
  href?: string
  document?: boolean
  back?: boolean
  ariaLabel?: string
  title?: string
}

type AppShellProps = {
  currentUserId: string
  mode: 'shift' | 'individual'
  homeHref: string
  switchHref: string
  inboxHref: string
  inboxCount: number
  inboxActive?: boolean
  privacySettingsHref?: string
  privacyMode?: 'cloud' | 'local-first'
  signInHref: string
  signOutAction: string
  workspaceFrameSrc?: string
  children?: RemixNode
  error?: string
  recording?: RecordingConfig
  processingStateHref?: string
  processingEventsHref?: string
  analyticsAction?: string
  nativeWorkflowSettlement?: 'complete' | 'error'
  csrfToken?: string
}

export function AppShell(handle: Handle<AppShellProps>) {
  return () => {
    let currentModeLabel = handle.props.mode === 'shift' ? 'Shift mode' : 'Individual mode'
    let nextModeLabel = handle.props.mode === 'shift' ? 'individual mode' : 'shift mode'

    return <div mix={css({ minHeight: "100vh" })}>
    <div mix={css({ marginInline: "auto", display: "flex", minHeight: "100vh", width: "100%", maxWidth: "none" })}>
      <main  mix={[css({ display: "flex", minHeight: "100vh", minWidth: "0", flex: "1", flexDirection: "column" }), shellBody]}>
        <header mix={css({
          position: 'sticky',
          top: '0',
          zIndex: '30',
          borderBottomStyle: 'solid',
          borderBottomWidth: '1px',
          borderColor: 'color-mix(in oklab, var(--color-slate-200) 55%, transparent)',
          backgroundColor: 'color-mix(in oklab, var(--color-white) 86%, transparent)',
          paddingInline: '1rem',
          paddingBlock: '1rem',
          WebkitBackdropFilter: 'blur(6px)',
          backdropFilter: 'blur(6px)',
          '@media (width >= 40rem)': {
            paddingInline: '1.5rem'
          }
        })}>
          <div mix={css({
            marginInline: 'auto',
            display: 'grid',
            width: '100%',
            maxWidth: '1320px',
            gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)',
            alignItems: 'center',
            gap: '0.5rem',
            '@media (width >= 40rem)': {
              gap: '1rem'
            }
          })}>
            <div mix={css({ display: "flex", minWidth: "0", alignItems: "center", gap: "0.75rem" })}>
              <a
                href={handle.props.homeHref}
                aria-label="Handover AI home"
                mix={css({
                  display: 'inline-flex',
                  minWidth: '0',
                  alignItems: 'center',
                  gap: '0.75rem',
                  borderRadius: '9999px',
                  paddingInline: '0.25rem',
                  paddingBlock: '0.25rem',
                  color: 'var(--color-slate-700)',
                  transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                  transitionDuration: '150ms',
                  '&:hover': {
                    '@media (hover: hover)': {
                      color: 'var(--color-slate-950)'
                    }
                  }
                })}
              >
                <span mix={css({
                  display: 'flex',
                  width: '2.25rem',
                  height: '2.25rem',
                  flexShrink: '0',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '14px',
                  borderStyle: 'solid',
                  borderWidth: '1px',
                  borderColor: 'color-mix(in oklab, var(--color-slate-200) 70%, transparent)',
                  backgroundColor: 'color-mix(in oklab, var(--color-slate-100) 85%, transparent)',
                  color: 'var(--color-slate-700)'
                })}>
                  <MessagesSquareIcon size={16} />
                </span>
                <span mix={css({
                  display: 'none',
                  minWidth: '0',
                  fontFamily: '\'Geist Variable\', sans-serif',
                  fontSize: '15px',
                  lineHeight: '1',
                  fontWeight: '500',
                  letterSpacing: '-0.025em',
                  '@media (width >= 40rem)': {
                    display: 'block'
                  }
                })}>
                  Handover AI
                </span>
              </a>
            </div>

            <div mix={css({ display: "flex", justifyContent: "center" })}>
              <Button
                href={handle.props.switchHref}
                variant="secondary"
                ariaLabel={`Switch to ${nextModeLabel}`}
                styles={{
                  width: '2.5rem',
                  height: '2rem',
                  borderRadius: 'var(--radius)',
                  borderColor: 'transparent',
                  backgroundColor: 'color-mix(in oklab, var(--color-white) 80%, transparent)',
                  paddingBlock: '0',
                  paddingInline: '0.625rem',
                  color: 'var(--color-slate-700)',
                  '&:hover': {
                    '@media (hover: hover)': {
                      borderColor: 'var(--color-slate-300)',
                      backgroundColor: 'var(--color-white)',
                      color: 'var(--color-slate-900)'
                    }
                  },
                  '@media (width >= 430px)': {
                    height: 'auto',
                    width: 'auto',
                    paddingInline: '0.75rem',
                    paddingBlock: '0.375rem'
                  }
                }}
              >
                <span mix={css({ display: "none", fontWeight: "500", "@media (width >= 430px)": { display: "inline" } })}>{currentModeLabel}</span>
                <RepeatIcon size={16} />
              </Button>
            </div>

            <div mix={css({ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.5rem" })}>
              {handle.props.privacySettingsHref && handle.props.privacyMode ? <a
                href={handle.props.privacySettingsHref}
                aria-label={`Audio privacy settings, local transcription active, deidentification ${handle.props.privacyMode === 'local-first' ? 'on' : 'off'}`}
                title={`Audio privacy settings · Deidentification ${handle.props.privacyMode === 'local-first' ? 'on' : 'off'}`}
                data-testid="privacy-status-link"
                mix={css({
                  ...{
                    display: 'inline-flex',
                    height: '2.25rem',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.5rem',
                    borderRadius: '9999px',
                    borderStyle: 'solid',
                    borderWidth: '1px',
                    paddingInline: '0.5rem',
                    fontSize: '0.875rem',
                    lineHeight: '1.42857143',
                    fontWeight: '500',
                    transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                    transitionDuration: '150ms',
                    '@media (width >= 40rem)': {
                      paddingInline: '0.75rem'
                    }
                  },
                  ...(handle.props.privacyMode === 'local-first' ? {
                    borderColor: 'var(--color-emerald-200)',
                    backgroundColor: 'var(--color-emerald-50)',
                    color: 'var(--color-emerald-800)',
                    '&:hover': {
                      '@media (hover: hover)': {
                        backgroundColor: 'var(--color-emerald-100)'
                      }
                    }
                  } : {
                    borderColor: 'color-mix(in oklab, var(--color-slate-200) 65%, transparent)',
                    backgroundColor: 'color-mix(in oklab, var(--color-white) 80%, transparent)',
                    color: 'var(--color-slate-600)',
                    '&:hover': {
                      '@media (hover: hover)': {
                        borderColor: 'var(--color-slate-300)',
                        backgroundColor: 'var(--color-white)',
                        color: 'var(--color-slate-900)'
                      }
                    }
                  })
                })}
              >
                <ShieldIcon size={16} />
                <span mix={css({ display: "none", "@media (width >= 64rem)": { display: "inline" } })}>Audio: Local</span>
              </a> : null}
              <a
                href={handle.props.inboxHref}
                aria-label={handle.props.inboxCount === 1 ? 'Inbox, 1 unactioned item' : `Inbox, ${handle.props.inboxCount} unactioned items`}
                aria-current={handle.props.inboxActive ? 'page' : undefined}
                mix={css({
                  ...{
                    display: 'inline-flex',
                    height: '2.25rem',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.5rem',
                    borderRadius: '9999px',
                    borderStyle: 'solid',
                    borderWidth: '1px',
                    paddingInline: '0.5rem',
                    fontSize: '0.875rem',
                    lineHeight: '1.42857143',
                    fontWeight: '500',
                    transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                    transitionDuration: '150ms',
                    '@media (width >= 40rem)': {
                      paddingInline: '0.75rem'
                    }
                  },
                  ...(handle.props.inboxActive ? {
                    borderColor: 'color-mix(in oklab, var(--primary) 20%, transparent)',
                    backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)',
                    color: 'var(--primary)'
                  } : {
                    borderColor: 'color-mix(in oklab, var(--color-slate-200) 65%, transparent)',
                    backgroundColor: 'color-mix(in oklab, var(--color-white) 80%, transparent)',
                    color: 'var(--color-slate-600)',
                    '&:hover': {
                      '@media (hover: hover)': {
                        borderColor: 'var(--color-slate-300)',
                        backgroundColor: 'var(--color-white)',
                        color: 'var(--color-slate-900)'
                      }
                    }
                  })
                })}
              >
                <InboxIcon size={16} />
                <span mix={css({ display: "none", "@media (width >= 40rem)": { display: "inline" } })}>Inbox</span>
                {handle.props.inboxCount > 0 ? <span mix={css({
                  minWidth: '1.25rem',
                  borderRadius: '9999px',
                  backgroundColor: 'var(--primary)',
                  paddingInline: '0.375rem',
                  paddingBlock: '0.125rem',
                  textAlign: 'center',
                  fontSize: '11px',
                  lineHeight: '1rem',
                  fontWeight: '600',
                  color: 'var(--color-white)'
                })}>{handle.props.inboxCount}</span> : null}
              </a>
              <form method="post" action={handle.props.signOutAction}>
                {csrf(handle.props.csrfToken)}
                <Button type="submit" variant="ghost" styles={{
                  borderRadius: 'var(--radius)',
                  paddingInline: '0.75rem',
                  color: 'var(--color-slate-500)',
                  '&:hover': {
                    '@media (hover: hover)': {
                      backgroundColor: 'var(--color-slate-100)',
                      color: 'var(--color-slate-900)'
                    }
                  }
                }}>Sign out</Button>
              </form>
            </div>
          </div>
        </header>

        {handle.props.error ? <div role="alert" data-testid="page-error" mix={css({
          marginInline: 'auto',
          marginTop: '1rem',
          width: 'calc(100% - 2rem)',
          maxWidth: '1320px',
          borderRadius: '16px',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'var(--color-rose-200)',
          backgroundColor: 'var(--color-rose-50)',
          paddingInline: '1rem',
          paddingBlock: '0.75rem',
          fontSize: '0.875rem',
          lineHeight: '1.5rem',
          color: 'var(--color-rose-900)',
          '@media (width >= 40rem)': {
            width: 'calc(100% - 3rem)'
          }
        })}><strong mix={css({ marginRight: "0.5rem", fontWeight: "500" })}>Could not save the change.</strong>{handle.props.error}</div> : null}
        {handle.props.workspaceFrameSrc
          ? <Frame name="workspace" src={handle.props.workspaceFrameSrc} fallback={<div id="main-content" tabIndex={-1} mix={loadingPanel}><Spinner label="Loading workspace" /></div>} />
          : handle.props.children}
      </main>
      {handle.props.processingStateHref ? <ProcessingCoordinator stateHref={handle.props.processingStateHref} eventsHref={handle.props.processingEventsHref} /> : null}
      <RecordingCoordinator
        currentUserId={handle.props.currentUserId}
        signInHref={handle.props.signInHref}
        signOutAction={handle.props.signOutAction}
        submitAction={handle.props.recording?.submitAction}
        uploadAction={handle.props.recording?.uploadAction}
        csrfToken={handle.props.recording?.csrfToken ?? handle.props.csrfToken}
        contextLabel={handle.props.recording?.contextLabel}
      />
      {handle.props.analyticsAction ? <AnalyticsCoordinator action={handle.props.analyticsAction} csrfToken={handle.props.csrfToken} mode={handle.props.mode} nativeWorkflowSettlement={handle.props.nativeWorkflowSettlement} /> : null}
    </div>
    </div>
  }
}

export function WorkspaceSurface(handle: Handle<{ breadcrumbs?: WorkspaceBreadcrumb[]; documentTitle?: string; children?: RemixNode }>) {
  return () => <div data-recording-reserve="none"  mix={[css({ flex: "1", paddingInline: "1rem", paddingBlock: "1rem", "@media (width >= 40rem)": { paddingInline: "1.5rem", paddingBlock: "1.5rem" } }), workspaceSurfaceStyle]}>
    {handle.props.documentTitle ? <WorkspaceTitleCoordinator title={handle.props.documentTitle} /> : null}
    <div mix={css({ marginInline: "auto", display: "flex", width: "100%", maxWidth: "1320px", flexDirection: "column", gap: "1.5rem" })}>
      {handle.props.breadcrumbs?.length ? <nav aria-label="Breadcrumb" mix={css({ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.375rem", fontSize: "15px", fontWeight: "500", color: "var(--color-slate-600)" })}>
        {handle.props.breadcrumbs.map((breadcrumb, index) => <span key={`${breadcrumb.label}-${index}`} mix={css({ display: "inline-flex", alignItems: "center", gap: "0.375rem" })}>
          {index ? <ChevronRightIcon styles={{ width: "1rem", height: "1rem", color: "var(--color-slate-300)" }} /> : null}
          {breadcrumb.href ? <a
            href={breadcrumb.href}
            mix={[css({
              display: 'inline-flex',
              minHeight: '2.25rem',
              alignItems: 'center',
              gap: '0.375rem',
              borderRadius: '9999px',
              paddingInline: '0.75rem',
              paddingBlock: '0.375rem',
              fontWeight: '600',
              color: 'var(--color-slate-700)',
              textDecorationLine: 'none',
              transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
              transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
              transitionDuration: '150ms',
              '&:hover': {
                '@media (hover: hover)': {
                  backgroundColor: 'color-mix(in oklab, var(--color-slate-900) 4%, transparent)',
                  color: 'var(--color-slate-950)'
                }
              },
              '&:focus-visible': {
                boxShadow: '0 0 0 2px color-mix(in oklab, var(--primary) 20%, transparent)',
                outlineStyle: 'none'
              }
            }), breadcrumb.document
              ? attrs({ 'data-rmx-document': '' })
              : link(breadcrumb.href, { target: 'workspace' })]}
            aria-label={breadcrumb.ariaLabel}
            title={breadcrumb.title}

          >
            {breadcrumb.back ? <ArrowLeftIcon /> : null}
            {breadcrumb.label}
          </a> : <span aria-current="page" mix={css({
            display: 'inline-flex',
            minHeight: '2.25rem',
            alignItems: 'center',
            borderRadius: '9999px',
            backgroundColor: 'color-mix(in oklab, var(--color-slate-900) 4%, transparent)',
            paddingInline: '0.75rem',
            paddingBlock: '0.375rem',
            fontWeight: '600',
            color: 'var(--color-slate-950)'
          })}>{breadcrumb.label}</span>}
        </span>)}
      </nav> : null}
      {handle.props.children}
    </div>
  </div>
}

function ErrorPage(handle: Handle<{ title?: string; message?: string; homeHref?: string; status?: number }>) {
  return () => <main id="main-content" tabIndex={-1} mix={errorPage}><Badge tone="danger">{handle.props.status ?? 500}</Badge><h1>{handle.props.title ?? 'Something went wrong'}</h1><p>{handle.props.message ?? 'The workspace could not complete that request. Your saved clinical data has not been changed.'}</p>{handle.props.homeHref ? <Button href={handle.props.homeHref} variant="primary">Return to workspace</Button> : null}</main>
}

export function NotFoundPage(handle: Handle<{ homeHref?: string }>) {
  return () => <ErrorPage status={404} title="Page not found" message="This workspace address does not exist or is no longer available." homeHref={handle.props.homeHref} />
}

function MessagesSquareIcon(handle: Handle<{ size?: number }>) {
  return () => <svg aria-hidden="true" width={handle.props.size ?? 24} height={handle.props.size ?? 24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /><path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1" /></svg>
}

function RepeatIcon(handle: Handle<{ size?: number }>) {
  return () => <svg aria-hidden="true" mix={css({ color: "var(--color-slate-400)" })} width={handle.props.size ?? 16} height={handle.props.size ?? 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m2 9 3-3 3 3" /><path d="M13 18H7a2 2 0 0 1-2-2V6" /><path d="m22 15-3 3-3-3" /><path d="M11 6h6a2 2 0 0 1 2 2v10" /></svg>
}

function InboxIcon(handle: Handle<{ size?: number }>) {
  return () => <svg aria-hidden="true" width={handle.props.size ?? 16} height={handle.props.size ?? 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>
}

function ShieldIcon(handle: Handle<{ size?: number }>) {
  return () => <svg aria-hidden="true" width={handle.props.size ?? 16} height={handle.props.size ?? 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z" /><path d="m9 12 2 2 4-4" /></svg>
}

function ArrowLeftIcon(_: Handle<Record<string, never>>) {
  return () => <svg aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
}

function ChevronRightIcon(handle: Handle<{ styles?: Parameters<typeof css>[0] }>) {
  return () => <svg aria-hidden="true" mix={css(handle.props.styles ?? { width: "1rem", height: "1rem" })} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
}

function csrf(token?: string): RemixNode {
  return token ? <input type="hidden" name="_csrf" value={token} /> : null
}

const shellBody = css({
  '& > iframe': { width: '100%', minHeight: '100vh', flex: '1', display: 'block', border: 0 },
})
const loadingPanel = css({ minHeight: '70vh', display: 'grid', placeItems: 'center' })
const workspaceSurfaceStyle = css({
  '&[data-recording-reserve=recording]': {
    paddingBottom: '10rem'
  },
  '&[data-recording-reserve=recommence-cue]': {
    paddingBottom: '16rem'
  },
  '@media (min-width: 640px)': {
    '&[data-recording-reserve=recording]': {
      paddingBottom: '11rem'
    },
    '&[data-recording-reserve=recommence-cue]': {
      paddingBottom: '14rem'
    }
  },
  '& #main-content': {
    width: '100%',
    maxWidth: 'none',
    margin: 0,
    padding: 0
  },
  '& #main-content > nav[aria-label=Breadcrumb]': {
    display: 'none'
  }
})
const errorPage = css({
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '13px',
  padding: '30px',
  textAlign: 'center',
  '& h1': {
    margin: 0,
    fontSize: 'clamp(2rem,5vw,4rem)'
  },
  '& p': {
    maxWidth: '560px',
    margin: '0 0 8px',
    color: '#657386'
  }
})
