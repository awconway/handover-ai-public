import { css, type Handle } from 'remix/component'

import { InboxPlacementForm } from '../assets/inbox-placement-form.tsx'
import { FrameMutationForm } from '../assets/frame-form.tsx'
import type { HandoverSummary, ShiftSummary } from './models.ts'
import { Badge, Button } from './primitives.tsx'

export function InboxAssignmentPanel(handle: Handle<{ assignment: HandoverSummary; shifts?: ShiftSummary[]; csrfToken?: string }>) {
  let item = handle.props.assignment
  return () => <article
    aria-label={`Received handover: ${item.title}`}
    data-testid={`inbox-assignment-${item.assignmentId ?? item.id}`}
    mix={css({
      display: 'grid',
      gap: '1rem',
      paddingInline: '1.25rem',
      paddingBlock: '1.25rem',
      '@media (width >= 64rem)': {
        gridTemplateColumns: 'minmax(0,1fr) auto',
        alignItems: 'center'
      }
    })}
  >
    <div mix={css({ minWidth: "0" })}>
      <div mix={css({
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: '0.75rem',
        rowGap: '0.25rem',
        fontSize: '11px',
        fontWeight: '500',
        letterSpacing: '0.16em',
        color: 'var(--color-slate-500)',
        textTransform: 'uppercase'
      })}>
        <span>From {item.assignedBy ?? 'Unknown sender'}</span>
        <span aria-hidden="true" mix={css({ color: "var(--color-slate-300)" })}>·</span>
        <span>{formatTimestamp(item.assignedAt)}</span>
      </div>
      <h2 mix={css({ marginTop: "0.5rem", fontSize: "1rem", lineHeight: "1.5", fontWeight: "600", color: "var(--color-slate-950)" })}>{item.title}</h2>
      <div mix={css({ marginTop: "0.25rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>{item.subtitle ?? 'Review this handover before placing it.'}</div>
      <div mix={css({
        marginTop: '0.75rem',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '0.5rem',
        fontSize: '0.75rem',
        lineHeight: '1.33333333',
        fontWeight: '500',
        color: 'var(--color-slate-500)'
      })}>
        <Badge styles={{ borderRadius: '9999px' }}>{item.direction ?? 'incoming'}</Badge>
        <span>{item.sourceShiftTitle
          ? `${item.sourceShiftTitle} · ${item.sourceShiftDepartment ?? item.routeLabel ?? ''}`
          : item.routeLabel ?? 'Route not recorded'}</span>
      </div>
    </div>
    <div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem", "@media (width >= 64rem)": { justifyContent: "flex-end" } })}>
      {item.addToIndividualAction ? <form method="post" action={item.addToIndividualAction} data-workflow="add-handover-to-individual">
        {csrf(handle.props.csrfToken)}
        <button type="submit" mix={css(inboxOutlineButtonStyles)}><HouseIcon />Add to individual</button>
      </form> : null}
      {item.placeAction ? <InboxPlacementForm
        action={item.placeAction}
        assignmentTitle={item.title}
        assignedBy={item.assignedBy ?? 'Unknown sender'}
        sourceLabel={item.sourceShiftTitle
          ? `${item.sourceShiftTitle} · ${item.sourceShiftDepartment ?? item.routeLabel ?? ''}`
          : item.routeLabel ?? 'Route not recorded'}
        shifts={handle.props.shifts ?? []}
        csrfToken={handle.props.csrfToken}
      /> : null}
      {item.dismissAction ? <FrameMutationForm action={item.dismissAction} workflow="dismiss-handover">
        {csrf(handle.props.csrfToken)}
        <button type="submit" mix={css(inboxGhostButtonStyles)}><TrashIcon />Remove</button>
      </FrameMutationForm> : null}
    </div>
  </article>
}

export function InboxPage(handle: Handle<{
  assignments?: HandoverSummary[]
  shifts?: ShiftSummary[]
  csrfToken?: string
  startShiftHref: string
}>) {
  let assignments = handle.props.assignments ?? []
  let shifts = handle.props.shifts ?? []
  let countLabel = assignments.length === 1 ? '1 unactioned' : `${assignments.length} unactioned`
  return () => <div id="main-content" tabIndex={-1} mix={css({ display: "grid", gap: "1.25rem" })} data-testid="inbox-page">
    <section mix={css({
      borderRadius: '26px',
      borderStyle: 'solid',
      borderWidth: '1px',
      borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
      backgroundColor: 'color-mix(in oklab, var(--color-white) 88%, transparent)',
      paddingInline: '1.25rem',
      paddingBlock: '1.25rem',
      '@media (width >= 40rem)': {
        paddingInline: '1.5rem'
      }
    })}>
      <div mix={css({
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
        '@media (width >= 40rem)': {
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between'
        }
      })}>
        <div>
          <div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Received handovers</div>
          <h1 mix={css({
            marginTop: '0.25rem',
            fontFamily: '\'Geist Variable\', sans-serif',
            fontSize: '1.5rem',
            lineHeight: '1.33333333',
            fontWeight: '500',
            letterSpacing: '-0.025em',
            color: 'var(--color-slate-950)'
          })}>Inbox</h1>
        </div>
        <Badge tone={assignments.length ? 'primary' : 'neutral'} styles={{ width: "fit-content", borderRadius: "9999px" }}>{countLabel}</Badge>
      </div>
    </section>

    <section mix={css({
      overflow: 'hidden',
      borderRadius: '26px',
      borderStyle: 'solid',
      borderWidth: '1px',
      borderColor: 'color-mix(in oklab, var(--color-white) 80%, transparent)',
      backgroundColor: 'color-mix(in oklab, var(--color-white) 92%, transparent)',
      boxShadow: '0 18px 42px rgba(44,56,75,0.06)'
    })}>
      {assignments.length ? <div mix={css({
        ':where(& > :not(:last-child))': {
          borderBottomStyle: 'solid',
          borderTopStyle: 'solid',
          borderTopWidth: '0px',
          borderBottomWidth: '1px',
          borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)'
        }
      })}>
        {assignments.map((assignment) => <InboxAssignmentPanel key={assignment.assignmentId ?? assignment.id} assignment={assignment} shifts={shifts} csrfToken={handle.props.csrfToken} />)}
      </div> : <div mix={css({ paddingInline: "1.25rem", paddingBlock: "2.5rem" })}>
        <div mix={css({ maxWidth: "36rem" })}>
          <div mix={css({ fontSize: "1rem", lineHeight: "1.5", fontWeight: "500", color: "var(--color-slate-950)" })}>No unactioned handovers</div>
          <p mix={css({ marginTop: "0.5rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>Received handovers will appear here before they are placed into a shift.</p>
          {!shifts.length ? <Button href={handle.props.startShiftHref} frameTarget="workspace" styles={{ marginTop: "1.25rem", borderRadius: "var(--radius)" }}><HistoryIcon />Start shift</Button> : null}
        </div>
      </div>}
    </section>

    {assignments.length && !shifts.length ? <section mix={css({
      borderRadius: '22px',
      borderStyle: 'solid',
      borderWidth: '1px',
      borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
      backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 80%, transparent)',
      paddingInline: '1.25rem',
      paddingBlock: '1rem'
    })}>
      <div mix={css({
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
        '@media (width >= 40rem)': {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between'
        }
      })}>
        <div mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>Start a shift before placing received handovers onto a board.</div>
        <Button href={handle.props.startShiftHref} frameTarget="workspace" styles={{ width: "fit-content", borderRadius: "var(--radius)" }}><HistoryIcon />Start shift</Button>
      </div>
    </section> : null}
  </div>
}

function formatTimestamp(value?: string) {
  if (!value) return 'Recently'
  let date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Recently'
  let parts = new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  let part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? ''
  return `${part('day')} ${part('month')} ${part('hour')}:${part('minute')}`
}

function HouseIcon() {
  return () => <svg data-icon="inline-start" viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M9 22V12h6v10" /></svg>
}

function TrashIcon() {
  return () => <svg data-icon="inline-start" viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" /></svg>
}

function HistoryIcon() {
  return () => <svg data-icon="inline-start" viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg>
}

const inboxButtonBaseStyles: Parameters<typeof css>[0] = {
  display: 'inline-flex',
  height: '2rem',
  flexShrink: '0',
  cursor: 'pointer',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.375rem',
  borderRadius: '9999px',
  borderStyle: 'solid',
  borderWidth: '1px',
  borderColor: 'transparent',
  backgroundClip: 'padding-box',
  paddingInline: '0.625rem',
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
    translate: '0 1px'
  },
  '&:disabled': {
    pointerEvents: 'none',
    cursor: 'not-allowed',
    opacity: '50%'
  }
}
const inboxOutlineButtonStyles: Parameters<typeof css>[0] = {
  ...inboxButtonBaseStyles,
  ...{
    borderColor: 'transparent',
    backgroundColor: 'var(--background)',
    color: 'var(--foreground)',
    '&:hover': {
      '@media (hover: hover)': {
        backgroundColor: 'var(--muted)',
        color: 'var(--foreground)'
      }
    }
  }
}
const inboxGhostButtonStyles: Parameters<typeof css>[0] = {
  ...inboxButtonBaseStyles,
  ...{
    color: 'var(--color-slate-500)',
    '&:hover': {
      '@media (hover: hover)': {
        backgroundColor: 'var(--color-slate-100)',
        color: 'var(--color-slate-900)'
      }
    }
  }
}

function csrf(token?: string) { return token ? <input type="hidden" name="_csrf" value={token} /> : null }
