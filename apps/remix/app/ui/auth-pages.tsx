import { css, type Handle } from 'remix/component'

import { AnalyticsCoordinator } from '../assets/analytics-coordinator.tsx'
import type { SessionSummary, UserSummary } from './models.ts'

export function LoginPage(handle: Handle<{ users?: UserSummary[]; signInAction: string; registerAction: string; csrfToken?: string; error?: string; analyticsAction?: string }>) {
  return () => {
    let users = handle.props.users ?? []

    return <main id="main-content" tabIndex={-1} mix={css({ minHeight: "100vh", paddingInline: "1rem", paddingBlock: "2.5rem", "@media (width >= 40rem)": { paddingInline: "1.5rem" } })}>
      <div mix={css({
        marginInline: 'auto',
        display: 'grid',
        maxWidth: '1280px',
        gap: '2rem',
        '@media (width >= 64rem)': {
          gridTemplateColumns: '0.78fr 1.22fr',
          alignItems: 'flex-start'
        }
      })}>
        <section mix={css({
          borderRadius: '34px',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'color-mix(in oklab, var(--color-white) 60%, transparent)',
          backgroundImage: 'linear-gradient(180deg,rgba(255,255,255,0.9),rgba(236,240,245,0.88))',
          paddingInline: '2rem',
          paddingBlock: '2.5rem',
          boxShadow: '0 20px 44px rgba(44,56,75,0.06)',
          '@media (width >= 40rem)': {
            paddingInline: '2.5rem',
            paddingBlock: '3rem'
          }
        })}>
          <div mix={css({ maxWidth: "36rem" })}>
            <div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.18em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>
              Clinical handover workspace
            </div>
            <h1 mix={css({
              marginTop: '1rem',
              fontFamily: '\'Geist Variable\', sans-serif',
              fontSize: 'clamp(2.4rem, 4.4vw, 4.2rem)',
              lineHeight: '0.95',
              fontWeight: '500',
              letterSpacing: '-0.025em',
              color: 'var(--color-slate-950)'
            })}>
              Sign in before you start
            </h1>
            <p mix={css({ marginTop: "1.25rem", maxWidth: "32rem", fontSize: "15px", lineHeight: "1.75rem", color: "var(--color-slate-600)" })}>
              Choose an existing clinician profile or set up a new one before you open a shift board
              or direct handover workflow.
            </p>

            <div mix={css({
              marginTop: '2rem',
              maxWidth: '36rem',
              overflow: 'hidden',
              borderRadius: '30px',
              borderStyle: 'solid',
              borderWidth: '1px',
              borderColor: 'color-mix(in oklab, var(--color-slate-200) 85%, transparent)',
              backgroundImage: 'linear-gradient(180deg,rgba(252,253,254,0.98),rgba(244,247,250,0.96))',
              color: 'var(--color-slate-900)',
              boxShadow: '0 14px 34px rgba(44,56,75,0.08)'
            })}>
              <div mix={css({
                borderBottomStyle: 'solid',
                borderBottomWidth: '1px',
                borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                paddingInline: '1.5rem',
                paddingBlock: '1.5rem'
              })}>
                <div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.75rem" })}>
                  <div mix={css({
                    borderRadius: '9999px',
                    backgroundColor: 'color-mix(in oklab, var(--color-slate-900) 4.5%, transparent)',
                    paddingInline: '0.75rem',
                    paddingBlock: '0.25rem',
                    fontSize: '11px',
                    fontWeight: '500',
                    letterSpacing: '0.18em',
                    color: 'var(--color-slate-600)',
                    textTransform: 'uppercase',
                    boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-900) 6%, transparent)'
                  })}>
                    Important
                  </div>
                  <div mix={css({
                    display: 'flex',
                    width: '2rem',
                    height: '2rem',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '9999px',
                    backgroundColor: 'color-mix(in oklab, var(--color-amber-100) 85%, transparent)',
                    boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-amber-200) 70%, transparent)'
                  })}>
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" mix={css({ width: "1rem", height: "1rem", color: "color-mix(in oklab, var(--color-amber-800) 80%, transparent)" })}>
                      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
                      <path d="M12 8v4" />
                      <path d="M12 16h.01" />
                    </svg>
                  </div>
                </div>
                <div mix={css({
                  marginTop: '1rem',
                  fontFamily: '\'Geist Variable\', sans-serif',
                  fontSize: 'clamp(1.35rem, 2.2vw, 1.85rem)',
                  lineHeight: '1.08',
                  fontWeight: '500',
                  letterSpacing: '-0.025em',
                  color: 'var(--color-slate-900)'
                })}>
                  This workspace supports clinical handover only
                </div>
                <p mix={css({ marginTop: "0.75rem", maxWidth: "36rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>
                  Read this before sign-in and continue using the formal documentation systems
                  already in place for the official clinical record.
                </p>
              </div>

              <div mix={css({
                display: 'grid',
                ':where(& > :not(:last-child))': {
                  borderBottomStyle: 'solid',
                  borderTopStyle: 'solid',
                  borderTopWidth: '0px',
                  borderBottomWidth: '1px',
                  borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)'
                },
                backgroundColor: 'color-mix(in oklab, var(--color-white) 40%, transparent)'
              })}>
                <div mix={css({
                  display: 'grid',
                  gap: '0.25rem',
                  paddingInline: '1.5rem',
                  paddingBlock: '1rem',
                  '@media (width >= 40rem)': {
                    gridTemplateColumns: '140px 1fr',
                    alignItems: 'flex-start',
                    gap: '1rem'
                  }
                })}>
                  <div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.18em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Voluntary use</div>
                  <div mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-700)" })}>Use of this workspace is voluntary.</div>
                </div>
                <div mix={css({
                  display: 'grid',
                  gap: '0.25rem',
                  paddingInline: '1.5rem',
                  paddingBlock: '1rem',
                  '@media (width >= 40rem)': {
                    gridTemplateColumns: '140px 1fr',
                    alignItems: 'flex-start',
                    gap: '1rem'
                  }
                })}>
                  <div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.18em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Medical record</div>
                  <div mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-700)" })}>This workspace is not integrated into the medical record.</div>
                </div>
                <div mix={css({
                  display: 'grid',
                  gap: '0.25rem',
                  paddingInline: '1.5rem',
                  paddingBlock: '1rem',
                  '@media (width >= 40rem)': {
                    gridTemplateColumns: '140px 1fr',
                    alignItems: 'flex-start',
                    gap: '1rem'
                  }
                })}>
                  <div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.18em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Documentation</div>
                  <div mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-700)" })}>
                    It is intended to support clinical handover rather than replace the formal
                    documentation systems already in place.
                  </div>
                </div>
              </div>
            </div>
          </div>

        </section>

        <div mix={css({ display: "grid", gap: "1.5rem" })}>
          {handle.props.error ? <div role="alert" mix={errorStyle}>{handle.props.error}</div> : null}
          <section mix={css({
            borderRadius: '30px',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'color-mix(in oklab, var(--color-white) 65%, transparent)',
            backgroundColor: 'color-mix(in oklab, var(--color-white) 86%, transparent)',
            padding: '1.5rem',
            boxShadow: '0 18px 40px rgba(44,56,75,0.06)',
            '@media (width >= 40rem)': {
              padding: '2rem'
            }
          })}>
            <div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: "1rem" })}>
              <div>
                <div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Recent clinician profiles</div>
                <h2 mix={css({
                  marginTop: '0.5rem',
                  fontFamily: '\'Geist Variable\', sans-serif',
                  fontSize: '1.5rem',
                  lineHeight: '1.33333333',
                  fontWeight: '500',
                  letterSpacing: '-0.025em',
                  color: 'var(--color-slate-950)'
                })}>Sign in</h2>
                <p mix={css({ marginTop: "0.5rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>
                  Pick an existing profile to reopen the workspace with that clinician’s department
                  and recent usage context.
                </p>
              </div>
              <span mix={css({
                ...badgeBaseStyles,
                ...{
                  backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 6%, transparent)',
                  color: 'var(--color-slate-700)',
                  boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-950) 10%, transparent)'
                }
              })}>
                {users.length} available
              </span>
            </div>

            <div mix={css({ marginTop: "1.5rem", display: "grid", gap: "0.75rem" })}>
              {users.length ? users.map((user) => <form method="post" action={handle.props.signInAction} key={user.id} data-workflow="sign-in" data-study-task="task-sign-in">
                <input type="hidden" name="userId" value={user.id} />
                {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
                <button type="submit" mix={css({
                  width: '100%',
                  borderRadius: '24px',
                  borderStyle: 'solid',
                  borderWidth: '1px',
                  borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                  backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 88%, transparent)',
                  padding: '1rem',
                  textAlign: 'left',
                  transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                  transitionDuration: '150ms',
                  '&:hover': {
                    '@media (hover: hover)': {
                      borderColor: 'color-mix(in oklab, var(--primary) 15%, transparent)',
                      backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)'
                    }
                  },
                  '&:disabled': {
                    opacity: '70%'
                  }
                })}>
                  <div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" })}>
                    <div>
                      <div mix={css({ fontWeight: "500", color: "var(--color-slate-950)" })}>{user.fullName}</div>
                      <div mix={css({ marginTop: "0.25rem", fontSize: "0.875rem", lineHeight: "1.42857143", color: "var(--color-slate-500)" })}>{user.occupation} · {user.department}</div>
                    </div>
                    <span mix={css({ alignSelf: "center", fontSize: "0.875rem", lineHeight: "1.42857143", fontWeight: "500", color: "var(--primary)" })}>Continue as this clinician</span>
                  </div>
                </button>
              </form>) : <p mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>No clinician profiles yet. Create the first profile below.</p>}
            </div>
          </section>

          <section mix={css({
            borderRadius: '28px',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'color-mix(in oklab, var(--color-slate-200) 70%, transparent)',
            backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 82%, transparent)',
            padding: '1.5rem',
            '@media (width >= 40rem)': {
              padding: '2rem'
            }
          })}>
            <div>
              <div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>New clinician</div>
              <h2 mix={css({
                marginTop: '0.5rem',
                fontFamily: '\'Geist Variable\', sans-serif',
                fontSize: '1.5rem',
                lineHeight: '1.33333333',
                fontWeight: '500',
                letterSpacing: '-0.025em',
                color: 'var(--color-slate-950)'
              })}>Create a profile and enter the workspace</h2>
              <p mix={css({ marginTop: "0.5rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>Set up a new clinician profile if this person has not used the workspace before.</p>
            </div>
            <form method="post" action={handle.props.registerAction} mix={css({ marginTop: "1.5rem", display: "grid", gap: "1rem" })} data-workflow="register-and-sign-in" data-study-task="task-register-profile">
              {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
              <div role="group" data-slot="field" data-orientation="vertical" mix={css(fieldVerticalStyles)}>
                <label htmlFor="register-full-name" data-slot="field-label" mix={css({ ...fieldLabelStyles, width: '100%' })}>Full name</label>
                <div data-slot="field-content" mix={css(fieldContentStyles)}>
                  <input id="register-full-name" name="fullName" autoComplete="name" required data-slot="input" mix={css(inputStyles)} />
                </div>
              </div>
              <div role="group" data-slot="field" data-orientation="responsive" mix={css(fieldResponsiveStyles)}>
                <div data-slot="field-content" mix={css(fieldContentStyles)}>
                  <label htmlFor="register-occupation" data-slot="field-label" mix={css(fieldLabelStyles)}>Occupation</label>
                  <input id="register-occupation" name="occupation" required data-slot="input" mix={css(inputStyles)} />
                </div>
                <div data-slot="field-content" mix={css(fieldContentStyles)}>
                  <label htmlFor="register-department" data-slot="field-label" mix={css(fieldLabelStyles)}>Department</label>
                  <input id="register-department" name="department" required data-slot="input" mix={css(inputStyles)} />
                </div>
              </div>
              <div mix={css({ display: "flex", justifyContent: "flex-end" })}>
                <button type="submit" data-slot="button" mix={css({
                  ...buttonBaseStyles,
                  ...{
                    height: '2rem',
                    gap: '0.375rem',
                    backgroundColor: 'var(--primary)',
                    paddingInline: '0.625rem',
                    color: 'var(--primary-foreground)',
                    '&:is(a)': {
                      '&:hover': {
                        '@media (hover: hover)': {
                          backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)'
                        }
                      }
                    }
                  }
                })}>
                  Create profile and sign in
                </button>
              </div>
            </form>
          </section>
        </div>
      </div>
      {handle.props.analyticsAction ? <AnalyticsCoordinator action={handle.props.analyticsAction} csrfToken={handle.props.csrfToken} mode="sign-in" /> : null}
    </main>
  }
}

export function ModeHomePage(handle: Handle<{ session: SessionSummary; shiftHref: string; individualHref: string; signOutAction: string; csrfToken?: string; analyticsAction?: string }>) {
  let sessionIdentity = `${handle.props.session.user.fullName} · ${handle.props.session.user.occupation} · ${handle.props.session.user.department}`

  return () => <main id="main-content" tabIndex={-1} mix={css({ minHeight: "100vh", paddingInline: "1rem", paddingBlock: "2.5rem", "@media (width >= 40rem)": { paddingInline: "1.5rem" } })}>
    <div mix={css({
      marginInline: 'auto',
      display: 'grid',
      maxWidth: '1280px',
      gap: '2rem',
      '@media (width >= 80rem)': {
        gridTemplateColumns: '0.78fr 1.22fr',
        alignItems: 'flex-start'
      }
    })}>
      <section data-testid="mode-home-hero" mix={css({
        minWidth: '0',
        borderRadius: '34px',
        borderStyle: 'solid',
        borderWidth: '1px',
        borderColor: 'color-mix(in oklab, var(--color-white) 10%, transparent)',
        backgroundColor: 'oklch(0.31 0.018 255)',
        paddingInline: '2rem',
        paddingBlock: '2.5rem',
        color: 'var(--color-slate-50)',
        boxShadow: '0 20px 44px rgba(44,56,75,0.1)',
        '@media (width >= 40rem)': {
          paddingInline: '2.5rem',
          paddingBlock: '3rem'
        }
      })}>
        <div data-testid="mode-home-session-row" mix={css({
          display: 'flex',
          width: '100%',
          maxWidth: '100%',
          minWidth: '0',
          flexWrap: 'nowrap',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '0.75rem',
          '@media (width >= 40rem)': {
            flexWrap: 'wrap'
          }
        })}>
          <div
            data-testid="mode-home-session-identity"
            mix={css({
              minWidth: '0',
              flex: '1',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              borderRadius: '9999px',
              borderStyle: 'solid',
              borderWidth: '1px',
              borderColor: 'color-mix(in oklab, var(--color-white) 15%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--color-white) 8%, transparent)',
              paddingInline: '0.75rem',
              paddingBlock: '0.5rem',
              fontSize: '0.875rem',
              lineHeight: '1.42857143',
              color: 'var(--color-slate-200)',
              '@media (width >= 40rem)': {
                flex: '0 auto',
                overflow: 'visible',
                textOverflow: 'clip',
                whiteSpace: 'normal'
              }
            })}
            title={sessionIdentity}
          >
            {sessionIdentity}
          </div>
          <form method="post" action={handle.props.signOutAction} mix={css({ flexShrink: "0" })}>
            {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
            <button type="submit" data-slot="button" mix={css({
              ...buttonBaseStyles,
              ...{
                height: '2rem',
                gap: '0.375rem',
                borderRadius: 'var(--radius)',
                borderColor: 'color-mix(in oklab, var(--color-white) 12%, transparent)',
                backgroundColor: 'color-mix(in oklab, var(--color-white) 6%, transparent)',
                paddingInline: '0.625rem',
                color: 'var(--color-white)',
                '&:hover': {
                  '@media (hover: hover)': {
                    backgroundColor: 'color-mix(in oklab, var(--color-white) 10%, transparent)',
                    color: 'var(--foreground)'
                  }
                }
              }
            })}>Sign out</button>
          </form>
        </div>

        <div mix={css({ marginTop: "2.5rem" })}>
          <div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.18em", color: "var(--color-slate-300)", textTransform: "uppercase" })}>Welcome back</div>
          <h1 mix={css({
            marginTop: '1rem',
            fontFamily: '\'Geist Variable\', sans-serif',
            fontSize: 'clamp(2.4rem, 4.3vw, 4.4rem)',
            lineHeight: '0.94',
            fontWeight: '500',
            letterSpacing: '-0.025em'
          })}>Choose the workflow before you begin</h1>
        </div>
      </section>

      <div mix={css({ display: "grid", gap: "1.5rem", "@media (width >= 64rem)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } })}>
        <a href={handle.props.shiftHref} aria-label="Open shift workflow" mix={css({
          order: '1',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '32px',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'color-mix(in oklab, var(--color-white) 65%, transparent)',
          backgroundColor: 'color-mix(in oklab, var(--color-white) 88%, transparent)',
          padding: '2rem',
          boxShadow: '0 18px 40px rgba(44,56,75,0.06)',
          transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
          transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
          transitionDuration: '150ms',
          '&:hover': {
            '@media (hover: hover)': {
              translate: '0 -0.125rem',
              borderColor: 'color-mix(in oklab, var(--primary) 30%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--color-white) 95%, transparent)',
              boxShadow: '0 22px 46px rgba(44,56,75,0.1)'
            }
          },
          '&:focus-visible': {
            boxShadow: '0 0 0 2px #fff, 0 0 0 calc(2px + 2px) color-mix(in oklab, var(--primary) 25%, transparent), 0 18px 40px rgba(44,56,75,0.06)',
            outlineStyle: 'none'
          },
          '&:active': {
            translate: '0 0rem'
          },
          '@media (prefers-reduced-motion: reduce)': {
            transform: 'none'
          },
          '@media (width >= 64rem)': {
            order: '1'
          }
        })} data-hover-surface="">
          <div mix={css({ marginBottom: "1.25rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" })}>
            <div mix={css({ display: "flex", alignItems: "center", gap: "0.75rem" })}>
              <div mix={css({
                display: 'flex',
                width: '3.25rem',
                height: '3.25rem',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '20px',
                backgroundColor: 'var(--primary)',
                color: 'var(--color-white)'
              })}>
                <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" />
                </svg>
              </div>
              <span mix={css({
                ...badgeBaseStyles,
                ...{
                  backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)',
                  color: 'var(--primary)',
                  boxShadow: '0 0 0 1px color-mix(in oklab, var(--primary) 15%, transparent)'
                }
              })}>Shift mode</span>
            </div>
            <span aria-hidden="true" mix={css({
              display: 'flex',
              width: '2.75rem',
              height: '2.75rem',
              flexShrink: '0',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '9999px',
              borderStyle: 'solid',
              borderWidth: '1px',
              borderColor: 'color-mix(in oklab, var(--primary) 15%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)',
              color: 'var(--primary)',
              transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
              transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
              transitionDuration: '150ms',
              '&:is(:where([data-hover-surface]):hover *)': {
                '@media (hover: hover)': {
                  backgroundColor: 'var(--primary)',
                  color: 'var(--color-white)'
                }
              }
            })}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" mix={css({
                width: '1.25rem',
                height: '1.25rem',
                transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                transitionDuration: '150ms',
                '&:is(:where([data-hover-surface]):hover *)': {
                  '@media (hover: hover)': {
                    translate: '0.125rem 0'
                  }
                },
                '@media (prefers-reduced-motion: reduce)': {
                  transform: 'none'
                }
              })}><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
            </span>
          </div>
          <div mix={css({
            fontFamily: '\'Geist Variable\', sans-serif',
            fontSize: 'clamp(2rem, 3vw, 3rem)',
            lineHeight: '0.98',
            fontWeight: '500',
            letterSpacing: '-0.025em',
            color: 'var(--color-slate-950)'
          })}>Enter shift workflow</div>
          <div mix={css({ marginTop: "1.5rem" })}>
            <div mix={css({
              display: 'inline-flex',
              minHeight: '2.75rem',
              alignItems: 'center',
              gap: '0.5rem',
              borderRadius: '9999px',
              backgroundColor: 'var(--primary)',
              paddingInline: '1rem',
              fontSize: '0.875rem',
              lineHeight: '1.42857143',
              fontWeight: '600',
              color: 'var(--color-white)',
              boxShadow: '0 10px 22px rgba(76,112,150,0.18)',
              transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
              transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
              transitionDuration: '150ms',
              '&:is(:where([data-hover-surface]):hover *)': {
                '@media (hover: hover)': {
                  backgroundColor: 'color-mix(in oklab, var(--primary) 90%, transparent)'
                }
              }
            })}>
              Open shift workflow
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" mix={css({
                width: '1rem',
                height: '1rem',
                transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                transitionDuration: '150ms',
                '&:is(:where([data-hover-surface]):hover *)': {
                  '@media (hover: hover)': {
                    translate: '0.125rem 0'
                  }
                },
                '@media (prefers-reduced-motion: reduce)': {
                  transform: 'none'
                }
              })}><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
            </div>
          </div>
        </a>

        <section mix={css({
          order: '3',
          borderRadius: '24px',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'color-mix(in oklab, var(--color-slate-200) 70%, transparent)',
          backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 82%, transparent)',
          padding: '1.25rem',
          '@media (width >= 64rem)': {
            gridColumn: 'span 2 / span 2'
          }
        })}>
          <div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>How to choose</div>
          <p mix={css({ marginTop: "0.75rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>Use shift mode for multi-patient receiving workflows. Use individual mode for direct handovers that should be reviewed on their own.</p>
        </section>

        <a href={handle.props.individualHref} aria-label="Open individual workflow" mix={css({
          order: '2',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '28px',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'color-mix(in oklab, var(--color-white) 65%, transparent)',
          backgroundColor: 'color-mix(in oklab, var(--color-white) 88%, transparent)',
          padding: '1.75rem',
          boxShadow: '0 16px 36px rgba(44,56,75,0.06)',
          transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
          transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
          transitionDuration: '150ms',
          '&:hover': {
            '@media (hover: hover)': {
              translate: '0 -0.125rem',
              borderColor: 'color-mix(in oklab, var(--color-slate-950) 15%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--color-white) 95%, transparent)',
              boxShadow: '0 20px 42px rgba(44,56,75,0.09)'
            }
          },
          '&:focus-visible': {
            boxShadow: '0 0 0 2px #fff, 0 0 0 calc(2px + 2px) color-mix(in oklab, var(--primary) 25%, transparent), 0 16px 36px rgba(44,56,75,0.06)',
            outlineStyle: 'none'
          },
          '&:active': {
            translate: '0 0rem'
          },
          '@media (prefers-reduced-motion: reduce)': {
            transform: 'none'
          }
        })} data-hover-surface="">
          <div mix={css({ marginBottom: "1rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" })}>
            <div mix={css({ display: "flex", alignItems: "center", gap: "0.75rem" })}>
              <div mix={css({
                display: 'flex',
                width: '3rem',
                height: '3rem',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '18px',
                backgroundColor: 'var(--color-slate-950)',
                color: 'var(--color-white)'
              })}>
                <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19v3" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><rect x="9" y="2" width="6" height="13" rx="3" /></svg>
              </div>
              <span mix={css({
                ...badgeBaseStyles,
                ...{
                  backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 6%, transparent)',
                  color: 'var(--color-slate-700)',
                  boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-950) 10%, transparent)'
                }
              })}>Individual mode</span>
            </div>
            <span aria-hidden="true" mix={css({
              display: 'flex',
              width: '2.5rem',
              height: '2.5rem',
              flexShrink: '0',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '9999px',
              borderStyle: 'solid',
              borderWidth: '1px',
              borderColor: 'color-mix(in oklab, var(--color-slate-950) 10%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 5%, transparent)',
              color: 'var(--color-slate-800)',
              transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
              transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
              transitionDuration: '150ms',
              '&:is(:where([data-hover-surface]):hover *)': {
                '@media (hover: hover)': {
                  backgroundColor: 'var(--color-slate-950)',
                  color: 'var(--color-white)'
                }
              }
            })}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" mix={css({
                width: '1rem',
                height: '1rem',
                transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                transitionDuration: '150ms',
                '&:is(:where([data-hover-surface]):hover *)': {
                  '@media (hover: hover)': {
                    translate: '0.125rem 0'
                  }
                },
                '@media (prefers-reduced-motion: reduce)': {
                  transform: 'none'
                }
              })}><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
            </span>
          </div>
          <div mix={css({
            fontFamily: '\'Geist Variable\', sans-serif',
            fontSize: '1.875rem',
            lineHeight: '1.2',
            fontWeight: '500',
            letterSpacing: '-0.025em',
            color: 'var(--color-slate-950)'
          })}>Start direct handover workflow</div>
          <div mix={css({ marginTop: "1.5rem" })}>
            <div mix={css({
              display: 'inline-flex',
              minHeight: '2.75rem',
              alignItems: 'center',
              gap: '0.5rem',
              borderRadius: '9999px',
              backgroundColor: 'var(--color-slate-950)',
              paddingInline: '1rem',
              fontSize: '0.875rem',
              lineHeight: '1.42857143',
              fontWeight: '600',
              color: 'var(--color-white)',
              boxShadow: '0 10px 22px rgba(15,23,42,0.14)',
              transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
              transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
              transitionDuration: '150ms',
              '&:is(:where([data-hover-surface]):hover *)': {
                '@media (hover: hover)': {
                  backgroundColor: 'var(--color-slate-800)'
                }
              }
            })}>
              Open individual workflow
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" mix={css({
                width: '1rem',
                height: '1rem',
                transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                transitionDuration: '150ms',
                '&:is(:where([data-hover-surface]):hover *)': {
                  '@media (hover: hover)': {
                    translate: '0.125rem 0'
                  }
                },
                '@media (prefers-reduced-motion: reduce)': {
                  transform: 'none'
                }
              })}><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
            </div>
          </div>
        </a>
      </div>
    </div>
    {handle.props.analyticsAction ? <AnalyticsCoordinator action={handle.props.analyticsAction} csrfToken={handle.props.csrfToken} mode="home" /> : null}
  </main>
}

const errorStyle = css({ padding: '14px', borderRadius: '14px', background: '#fff0f1', border: '1px solid #f0c5ca', color: '#922f3c' })

const badgeBaseStyles: Parameters<typeof css>[0] = {
  display: 'inline-flex',
  height: '1.25rem',
  width: 'fit-content',
  flexShrink: '0',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.25rem',
  overflow: 'hidden',
  borderRadius: 'calc(var(--radius) * 2.6)',
  borderStyle: 'solid',
  borderWidth: '1px',
  borderColor: 'transparent',
  paddingInline: '0.5rem',
  paddingBlock: '0.125rem',
  fontSize: '0.75rem',
  lineHeight: '1.33333333',
  fontWeight: '500',
  whiteSpace: 'nowrap',
  transitionProperty: 'all',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  '&:focus-visible': {
    borderColor: 'var(--ring)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
  }
}
const buttonBaseStyles: Parameters<typeof css>[0] = {
  display: 'inline-flex',
  flexShrink: '0',
  cursor: 'pointer',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 'var(--radius)',
  borderStyle: 'solid',
  borderWidth: '1px',
  borderColor: 'transparent',
  backgroundClip: 'padding-box',
  fontSize: '0.875rem',
  lineHeight: '1.42857143',
  fontWeight: '500',
  whiteSpace: 'nowrap',
  transitionProperty: 'all',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  outlineStyle: 'none',
  WebkitUserSelect: 'none',
  userSelect: 'none',
  '&:focus-visible': {
    borderColor: 'var(--ring)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
  },
  '&:active': {
    '&:not(*[aria-haspopup])': {
      translate: '0 1px'
    }
  },
  '&:disabled': {
    pointerEvents: 'none',
    cursor: 'not-allowed',
    opacity: '50%'
  }
}
const fieldVerticalStyles: Parameters<typeof css>[0] = {
  display: 'flex',
  width: '100%',
  flexDirection: 'column',
  gap: '0.5rem',
  '& > [data-slot]': {
    width: '100%'
  },
  '&[data-invalid="true"]': {
    color: 'var(--destructive)'
  },
  '&>[data-visually-hidden]': {
    width: 'auto'
  }
}
const fieldResponsiveStyles: Parameters<typeof css>[0] = {
  display: 'flex',
  width: '100%',
  flexDirection: 'column',
  gap: '0.5rem',
  '& > [data-slot]': {
    width: '100%'
  },
  '&[data-invalid="true"]': {
    color: 'var(--destructive)'
  },
  '@container field-group (width >= 28rem)': {
    flexDirection: 'row',
    alignItems: 'center',
    '& > [data-slot]': {
      width: 'auto',
      '&[data-slot="field-label"]': {
        flex: 'auto'
      }
    },
    '&:has(>[data-slot=field-content])': {
      alignItems: 'flex-start'
    }
  },
  '&>[data-visually-hidden]': {
    width: 'auto'
  }
}
const fieldContentStyles: Parameters<typeof css>[0] = { display: "flex", flex: "1", flexDirection: "column", gap: "0.125rem", lineHeight: "1.375" }
const fieldLabelStyles: Parameters<typeof css>[0] = {
  display: 'flex',
  width: 'fit-content',
  alignItems: 'center',
  gap: '0.5rem',
  fontSize: '0.875rem',
  lineHeight: '1.375',
  fontWeight: '500',
  WebkitUserSelect: 'none',
  userSelect: 'none'
}
const inputStyles: Parameters<typeof css>[0] = {
  display: 'block',
  height: '2rem',
  width: '100%',
  minWidth: '0',
  borderRadius: 'var(--radius)',
  borderStyle: 'solid',
  borderWidth: '1px',
  borderColor: 'var(--input)',
  backgroundColor: 'transparent',
  paddingInline: '0.625rem',
  paddingBlock: '0.25rem',
  fontSize: '1rem',
  lineHeight: '1.5',
  transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  outlineStyle: 'none',
  '&::file-selector-button': {
    display: 'inline-flex',
    height: '1.5rem',
    borderStyle: 'solid',
    borderWidth: '0px',
    backgroundColor: 'transparent',
    fontSize: '0.875rem',
    lineHeight: '1.42857143',
    fontWeight: '500',
    color: 'var(--foreground)'
  },
  '&::placeholder': {
    color: 'var(--muted-foreground)'
  },
  '&:focus-visible': {
    borderColor: 'var(--ring)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
  },
  '&:disabled': {
    pointerEvents: 'none',
    cursor: 'not-allowed',
    backgroundColor: 'color-mix(in oklab, var(--input) 50%, transparent)',
    opacity: '50%'
  },
  '&[aria-invalid="true"]': {
    borderColor: 'var(--destructive)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--destructive) 20%, transparent)'
  },
  '@media (width >= 48rem)': {
    fontSize: '0.875rem',
    lineHeight: '1.42857143'
  }
}
