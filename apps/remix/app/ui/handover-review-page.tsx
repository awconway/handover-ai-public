import { css, link, type Handle, type RemixNode } from 'remix/component'

import { ChecklistEditor } from '../assets/checklist-editor.tsx'
import { DeleteHandoverDialog } from '../assets/delete-handover-dialog.tsx'
import { FrameMutationEnhancer, FrameMutationForm } from '../assets/frame-form.tsx'
import { InboxPlacementForm } from '../assets/inbox-placement-form.tsx'
import { NoiseMetric } from '../assets/noise-metric.tsx'
import { PatientActionsPanel } from '../assets/patient-actions-panel.tsx'
import { PrivacyFindingAllowControl } from '../assets/privacy-finding-allow-control.tsx'
import { ProcessingTimeline } from '../assets/processing-timeline.tsx'
import { RecommenceHandoverButton } from '../assets/recommence-handover-button.tsx'
import { RichTextEditor } from '../assets/rich-text-editor.tsx'
import { SendHandoverDialog } from '../assets/send-handover-dialog.tsx'
import type {
  ReviewAnalysis,
  ReviewChecklistItem,
  ReviewCommunicationRisk,
  ReviewSummary,
  ReviewSummaryEdit,
  ReviewTranscriptPrivacyAudit,
  ReviewTranscriptPrivacyFinding,
  ReviewTranscriptionMetadata,
} from '../utils/handover-review.ts'
import type { DirectoryOption, HandoverSummary, TaskSummary } from './models.ts'

type ReviewTab = { key: string; label: string; href: string; count?: number; disabled?: boolean }

export function HandoverReviewPage(handle: Handle<{
  handover: HandoverSummary
  tabs: ReviewTab[]
  activeTab: string
  analysis?: ReviewAnalysis | null
  transcriptionMetadata?: ReviewTranscriptionMetadata | null
  transcript?: string
  transcriptPrivacy?: ReviewTranscriptPrivacyAudit | null
  transcriptPrivacyExpected?: boolean
  transcriptPrivacyAllowAction?: string
  transcriptPrivacyAnalysisStale?: boolean
  rerunAnalysisAction?: string
  tasks?: TaskSummary[]
  contextType?: string
  consentMode?: string
  participants?: string[]
  patientKey?: string
  patientDisplayName?: string
  patientLocation?: string
  patientWorkspaceHref?: string
  patientActionsHref?: string
  editPatientDetails?: boolean
  metadataFormState?: {
    participants: string
    patients: Array<{ patientKey: string; displayName: string; location: string }>
    errors: { form?: string; participants?: string; patients?: Array<{ displayName?: string; location?: string }> }
  }
  processingStartedAt?: string
  interactionsDisabled?: boolean
  metadataAction?: string
  checklistAction?: string
  summaryAction?: string
  summaryReviewAction?: string
  assignmentAction?: string
  extendAction?: string
  recipients?: DirectoryOption[]
  taskAction?: string
  uncertaintyTaskActions?: Record<string, string>
  viewerPerspective?: 'receiving' | 'delivering'
  retryAction?: string
  discardFailedAction?: string
  deleteAction?: string
  inboxPlacement?: {
    action: string
    assignmentTitle: string
    assignedBy: string
    sourceLabel: string
    shifts: Array<{ id: string; title: string; department?: string }>
  }
  csrfToken?: string
}>) {
  return () => {
    let props = handle.props
    let analysis = props.analysis ?? null
    let participants = props.metadataFormState
      ? props.metadataFormState.participants.split(/[,\n]/).map((value) => value.trim()).filter(Boolean)
      : props.participants?.length ? props.participants : analysis?.participants ?? []
    let completed = props.handover.status === 'completed'
    let processing = props.handover.status !== 'completed' && props.handover.status !== 'failed'
    let linkedPatientLabel = props.patientDisplayName
      ? `${props.patientDisplayName}${props.patientLocation ? ` · ${props.patientLocation}` : ''}`
      : null
    let headerPatients = !linkedPatientLabel && (completed || analysis?.analysisReadiness.patients)
      ? analysis?.patients ?? []
      : []
    let analysisPatientLabel = headerPatients.length
      ? `${headerPatients.slice(0, 2).map((patient) => `${patient.displayName}${patient.location.trim() ? ` · ${patient.location}` : ''}`).join(' • ')}${headerPatients.length > 2 ? ` +${headerPatients.length - 2} more` : ''}`
      : null
    let hasStablePatientDetails = Boolean(linkedPatientLabel || analysisPatientLabel)
    let patientLabel = linkedPatientLabel
      ?? analysisPatientLabel
      ?? (processing ? 'Patient details are being prepared' : 'Patient details not available')
    let patientCardPrimaryLabel = patientLabel.split(' · ')[0] ?? patientLabel
    let editingPatientDetails = Boolean(props.editPatientDetails || props.metadataFormState)
    let showPatientScopePlaceholder = !editingPatientDetails && processing && !hasStablePatientDetails
    let showParticipantsPlaceholder = !editingPatientDetails && processing && participants.length === 0
    let detailsHref = props.tabs.find((tab) => tab.key === 'details')?.href
    let activeHref = props.tabs.find((tab) => tab.key === props.activeTab && !tab.disabled)?.href ?? detailsHref
    let editDetailsHref = activeHref ? `${activeHref}${activeHref.includes('?') ? '&' : '?'}edit=patient#edit-patient-details` : undefined
    let patientDrafts = props.metadataFormState?.patients ?? reviewPatients(analysis, props.patientKey, props.patientDisplayName, props.patientLocation)
    let restartCues = recommenceCues(props.handover.id, props.handover.status, analysis, props.transcriptionMetadata ?? null, props.transcript ?? '', props.handover.routeLabel, props.patientKey, props.patientDisplayName)
    // Processing time must never fall back to the handover's age. A completed
    // retry may intentionally clear processing_started_at; using createdAt in
    // that case made a 13-second retry appear to have taken 19 minutes.
    let startAt = props.processingStartedAt

    return <div id="main-content" tabIndex={-1} mix={css({ display: "flex", minWidth: "0", flexDirection: "column", gap: "0.75rem", "@media (width >= 48rem)": { gap: "1.25rem" } })} data-testid="handover-review-workspace">
      <h1 id="handover-review-title" mix={css({
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: '0',
        margin: '-1px',
        overflow: 'hidden',
        clipPath: 'inset(50%)',
        whiteSpace: 'nowrap',
        borderWidth: '0'
      })} data-visually-hidden="">{`Handover review · ${props.handover.title} · ${patientLabel}`}</h1>
      {props.patientWorkspaceHref ? <a href={props.patientWorkspaceHref} mix={[css({
        marginBottom: '0',
        display: 'inline-flex',
        height: '2rem',
        width: 'fit-content',
        flexShrink: '0',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.375rem',
        borderRadius: '9999px',
        borderStyle: 'solid',
        borderWidth: '1px',
        borderColor: 'transparent',
        backgroundClip: 'padding-box',
        paddingInline: '0',
        fontSize: '0.875rem',
        lineHeight: '1.42857143',
        fontWeight: '500',
        whiteSpace: 'nowrap',
        color: 'var(--foreground)',
        textDecorationLine: 'none',
        transitionProperty: 'all',
        transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
        transitionDuration: '150ms',
        outlineStyle: 'none',
        '&:hover': {
          '@media (hover: hover)': {
            backgroundColor: 'var(--muted)',
            color: 'var(--foreground)'
          }
        },
        '&:focus-visible': {
          borderColor: 'var(--ring)',
          boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
        },
        '&:active': {
          translate: '0 1px'
        },
        '@media (width >= 40rem)': {
          marginBottom: '0.25rem'
        },
        '@media (width >= 48rem)': {
          marginBottom: '-0.25rem'
        }
      }), link(props.patientWorkspaceHref, { target: 'workspace' })]} ><ArrowLeftIcon />Back to patient</a> : null}
      <ProcessingTimeline
        handoverId={props.handover.id}
        status={props.handover.status ?? 'draft'}
        startedAt={startAt}
        updatedAt={props.handover.updatedAt}
        retryAction={props.retryAction}
        discardAction={props.handover.status === 'failed' ? props.discardFailedAction : undefined}
        csrfToken={props.csrfToken}
        transcriptAvailable={Boolean(props.transcript?.trim())}
      />

      <div mix={css({ display: "grid", gap: "0.75rem", "@media (width >= 48rem)": { gridTemplateColumns: "minmax(0,1fr) 340px", alignItems: "flex-start", gap: "1.25rem" } })}>
        <section
          data-testid="review-patient-header"
          mix={css({
            ...{
              borderStyle: 'solid',
              borderWidth: '1px',
              borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--color-white) 82%, transparent)'
            },
            ...(editingPatientDetails ? {
              borderRadius: '20px',
              paddingInline: '1rem',
              paddingBlock: '0.75rem',
              '@media (width >= 48rem)': {
                borderRadius: '26px',
                paddingInline: '1.5rem',
                paddingBlock: '1.25rem'
              }
            } : {
              borderRadius: '20px',
              padding: '0',
              '@media (width >= 48rem)': {
                borderRadius: '26px',
                paddingInline: '1.5rem',
                paddingBlock: '1.25rem'
              }
            })
          })}
        >
          {!editingPatientDetails ? editDetailsHref ? <a
            href={editDetailsHref}
            mix={[css({
              display: 'flex',
              minHeight: '4rem',
              width: '100%',
              alignItems: 'center',
              gap: '0.75rem',
              borderRadius: '20px',
              paddingInline: '1rem',
              paddingBlock: '0.75rem',
              textAlign: 'left',
              textDecorationLine: 'none',
              transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
              transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
              transitionDuration: '150ms',
              '&:hover': {
                '@media (hover: hover)': {
                  backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 70%, transparent)'
                }
              },
              '&:focus-visible': {
                boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 40%, transparent)',
                outlineStyle: 'none'
              },
              '@media (width >= 48rem)': {
                display: 'none'
              }
            }), link(editDetailsHref, { target: 'workspace', resetScroll: false })]}
            aria-label="Edit patient details"
            data-testid="review-patient-summary-mobile"

          >
            {showPatientScopePlaceholder ? <span mix={css({ display: "flex", minWidth: "0", flex: "1", alignItems: "center", paddingBlock: "0.25rem" })} aria-label="Patient handover scope loading"><span mix={css({
              display: 'block',
              height: '0.75rem',
              width: 'min(16rem, 74%)',
              animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
              borderRadius: '9999px',
              backgroundColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)'
            })} /></span> : <span mix={css({ display: "flex", minWidth: "0", flex: "1", flexDirection: "column", gap: "0.25rem", overflow: "hidden", lineHeight: "1.25rem" })}>
              <span mix={css({ display: "flex", minWidth: "0", alignItems: "baseline", gap: "0.5rem" })}>
                <span mix={css({
                  minWidth: '0',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: '1rem',
                  lineHeight: '1.5',
                  fontWeight: '600',
                  color: 'var(--color-slate-950)'
                })}>{patientCardPrimaryLabel}</span>
                <span aria-hidden="true" mix={css({ flexShrink: "0", color: "var(--color-slate-400)" })}>·</span>
                <span mix={css({ flexShrink: "0", fontSize: "0.75rem", lineHeight: "1.33333333", fontWeight: "500", color: "var(--color-slate-500)" })}>{formatTimestamp(props.handover.updatedAt ?? props.handover.createdAt)}</span>
              </span>
              <span mix={css({
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.375rem',
                fontSize: '0.75rem',
                lineHeight: '1.33333333',
                fontWeight: '600',
                color: 'var(--color-slate-600)'
              })}><PencilIcon />Edit patient details</span>
            </span>}
            <span mix={css({ "& svg": { width: "1.25rem", height: "1.25rem" } })}><ChevronRightIcon /></span>
          </a> : <div data-testid="review-patient-summary-mobile" mix={css({
            display: 'flex',
            minHeight: '4rem',
            width: '100%',
            alignItems: 'center',
            gap: '0.75rem',
            borderRadius: '20px',
            paddingInline: '1rem',
            paddingBlock: '0.75rem',
            '@media (width >= 48rem)': {
              display: 'none'
            }
          })}>
            <span mix={css({ display: "flex", minWidth: "0", flex: "1", flexDirection: "column", gap: "0.25rem", overflow: "hidden", lineHeight: "1.25rem" })}>
              <span mix={css({ display: "flex", minWidth: "0", alignItems: "baseline", gap: "0.5rem" })}>
                <span mix={css({
                  minWidth: '0',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: '1rem',
                  lineHeight: '1.5',
                  fontWeight: '600',
                  color: 'var(--color-slate-950)'
                })}>{patientCardPrimaryLabel}</span>
                <span aria-hidden="true" mix={css({ flexShrink: "0", color: "var(--color-slate-400)" })}>·</span>
                <span mix={css({ flexShrink: "0", fontSize: "0.75rem", lineHeight: "1.33333333", fontWeight: "500", color: "var(--color-slate-500)" })}>{formatTimestamp(props.handover.updatedAt ?? props.handover.createdAt)}</span>
              </span>
            </span>
          </div> : null}

          <div data-testid="review-patient-summary-desktop" mix={css({ display: editingPatientDetails ? "flex" : "none", flexDirection: "column", gap: "0.75rem", "@media (width >= 48rem)": { display: "flex", gap: "1.25rem" } })}>
            <div mix={css({
              minWidth: '0',
              flex: '1',
              ':where(& > :not(:last-child))': {
                marginBlockStart: '0px',
                marginBlockEnd: '0.75rem'
              },
              '@media (width >= 48rem)': {
                ':where(& > :not(:last-child))': {
                  marginBlockStart: '0px',
                  marginBlockEnd: '1.25rem'
                }
              }
            })}>
              <div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" })}>
                <div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" })}>
                  <span mix={css({
                    display: 'inline-flex',
                    height: '1.25rem',
                    width: 'fit-content',
                    flexShrink: '0',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '9999px',
                    borderStyle: 'solid',
                    borderWidth: '1px',
                    borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                    backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 80%, transparent)',
                    paddingInline: '0.625rem',
                    paddingBlock: '0.125rem',
                    fontSize: '11px',
                    fontWeight: '500',
                    whiteSpace: 'nowrap',
                    color: 'var(--color-slate-700)',
                    '@media (width >= 48rem)': {
                      paddingInline: '0.75rem',
                      paddingBlock: '0.25rem',
                      fontSize: '0.75rem',
                      lineHeight: '1.33333333'
                    }
                  })}>{contextLabel(props.contextType)}</span>
                  {props.handover.status !== 'completed' && props.handover.status !== 'failed' ? <span mix={css({
                    display: 'inline-flex',
                    height: '1.25rem',
                    width: 'fit-content',
                    flexShrink: '0',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '9999px',
                    backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)',
                    paddingInline: '0.625rem',
                    paddingBlock: '0.125rem',
                    fontSize: '11px',
                    fontWeight: '500',
                    whiteSpace: 'nowrap',
                    color: 'var(--primary)',
                    boxShadow: '0 0 0 1px color-mix(in oklab, var(--primary) 15%, transparent)',
                    '@media (width >= 48rem)': {
                      paddingInline: '0.75rem',
                      paddingBlock: '0.25rem',
                      fontSize: '0.75rem',
                      lineHeight: '1.33333333'
                    }
                  })}>Draft review</span> : null}
                  <span mix={css({
                    fontSize: '10px',
                    fontWeight: '500',
                    letterSpacing: '0.14em',
                    color: 'var(--color-slate-500)',
                    textTransform: 'uppercase',
                    '@media (width >= 48rem)': {
                      fontSize: '11px',
                      letterSpacing: '0.18em'
                    }
                  })}>Updated {formatTimestamp(props.handover.updatedAt ?? props.handover.createdAt)}</span>
                </div>
                {editingPatientDetails && props.metadataAction ? <div mix={css({ display: "none", flexWrap: "wrap", alignItems: "center", gap: "0.5rem", "@media (width >= 48rem)": { display: "flex" } })}>
                  {activeHref ? <a href={activeHref} mix={[css({
                    display: 'inline-flex',
                    height: '2rem',
                    flexShrink: '0',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '9999px',
                    borderStyle: 'solid',
                    borderWidth: '1px',
                    borderColor: 'var(--border)',
                    backgroundColor: 'var(--background)',
                    paddingInline: '0.75rem',
                    fontSize: '0.875rem',
                    lineHeight: '1.42857143',
                    fontWeight: '500',
                    whiteSpace: 'nowrap',
                    color: 'var(--foreground)',
                    textDecorationLine: 'none',
                    transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                    transitionDuration: '150ms',
                    '&:hover': {
                      '@media (hover: hover)': {
                        backgroundColor: 'var(--muted)'
                      }
                    }
                  }), link(activeHref, { target: 'workspace', resetScroll: false })]} aria-label="Cancel patient details edit" >Cancel</a> : null}
                  <button type="submit" form="edit-patient-details" mix={css({
                    display: 'inline-flex',
                    height: '2rem',
                    flexShrink: '0',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.375rem',
                    borderRadius: '9999px',
                    backgroundColor: 'var(--primary)',
                    paddingInline: '0.75rem',
                    fontSize: '0.875rem',
                    lineHeight: '1.42857143',
                    fontWeight: '500',
                    whiteSpace: 'nowrap',
                    color: 'var(--primary-foreground)',
                    transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                    transitionDuration: '150ms',
                    '&:hover': {
                      '@media (hover: hover)': {
                        backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)'
                      }
                    }
                  })}><CheckIcon />Save details</button>
                </div> : editDetailsHref ? <a href={editDetailsHref} mix={[css({
                  display: 'none',
                  height: '2rem',
                  flexShrink: '0',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.375rem',
                  borderRadius: '9999px',
                  borderStyle: 'solid',
                  borderWidth: '1px',
                  borderColor: 'var(--border)',
                  backgroundColor: 'var(--background)',
                  paddingInline: '0.75rem',
                  fontSize: '0.875rem',
                  lineHeight: '1.42857143',
                  fontWeight: '500',
                  whiteSpace: 'nowrap',
                  color: 'var(--foreground)',
                  textDecorationLine: 'none',
                  transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                  transitionDuration: '150ms',
                  '&:hover': {
                    '@media (hover: hover)': {
                      backgroundColor: 'var(--muted)',
                      color: 'var(--foreground)'
                    }
                  },
                  '@media (width >= 48rem)': {
                    display: 'inline-flex'
                  }
                }), link(editDetailsHref, { target: 'workspace', resetScroll: false })]} data-testid="review-patient-edit-desktop" ><PencilIcon />Edit patient details</a> : null}
              </div>

              {editingPatientDetails && props.metadataAction ? <form id="edit-patient-details" method="post" action={props.metadataAction} mix={css({ display: "grid", scrollMarginTop: "7rem", gap: "1rem" })} data-workflow="edit-details">
                {csrf(props.csrfToken)}
                <input type="hidden" name="patientKeys" value={JSON.stringify(patientDrafts.map((patient) => patient.patientKey))} />
                {props.metadataFormState?.errors.form ? <div role="alert" mix={css({
                  borderRadius: '14px',
                  borderStyle: 'solid',
                  borderWidth: '1px',
                  borderColor: 'var(--color-rose-200)',
                  backgroundColor: 'var(--color-rose-50)',
                  paddingInline: '0.75rem',
                  paddingBlock: '0.5rem',
                  fontSize: '0.875rem',
                  lineHeight: '1.5rem',
                  color: 'var(--color-rose-900)'
                })}>{props.metadataFormState.errors.form}</div> : null}
                <div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", "@media (width >= 48rem)": { display: "none" } })}>
                  <div mix={css({ fontSize: "0.875rem", lineHeight: "1.42857143", fontWeight: "600", color: "var(--color-slate-950)" })}>Patient details</div>
                  <div mix={css({ display: "flex", alignItems: "center", gap: "0.5rem" })}>
                    {activeHref ? <a href={activeHref} mix={[css({
                      display: 'inline-flex',
                      height: '2rem',
                      flexShrink: '0',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: '9999px',
                      borderStyle: 'solid',
                      borderWidth: '1px',
                      borderColor: 'var(--border)',
                      backgroundColor: 'var(--background)',
                      paddingInline: '0.75rem',
                      fontSize: '0.75rem',
                      lineHeight: '1.33333333',
                      fontWeight: '500',
                      whiteSpace: 'nowrap',
                      color: 'var(--foreground)',
                      textDecorationLine: 'none',
                      transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                      transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                      transitionDuration: '150ms',
                      '&:hover': {
                        '@media (hover: hover)': {
                          backgroundColor: 'var(--muted)'
                        }
                      }
                    }), link(activeHref, { target: 'workspace', resetScroll: false })]} aria-label="Cancel patient details edit" >Cancel</a> : null}
                    <button type="submit" mix={css({
                      display: 'inline-flex',
                      height: '2rem',
                      flexShrink: '0',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: '9999px',
                      backgroundColor: 'var(--primary)',
                      paddingInline: '0.75rem',
                      fontSize: '0.75rem',
                      lineHeight: '1.33333333',
                      fontWeight: '500',
                      whiteSpace: 'nowrap',
                      color: 'var(--primary-foreground)',
                      transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                      transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                      transitionDuration: '150ms',
                      '&:hover': {
                        '@media (hover: hover)': {
                          backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)'
                        }
                      }
                    })}>Save details</button>
                  </div>
                </div>
                <div mix={css({ display: "grid", gap: "0.75rem" })}>
                  {patientDrafts.length ? patientDrafts.map((patient, index) => <div key={patient.patientKey} mix={css({
                    display: 'grid',
                    gap: '0.75rem',
                    borderRadius: '20px',
                    borderStyle: 'solid',
                    borderWidth: '1px',
                    borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                    backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 72%, transparent)',
                    padding: '0.75rem',
                    '@media (width >= 48rem)': {
                      gridTemplateColumns: 'minmax(0,1.1fr) minmax(0,0.9fr)'
                    }
                  })}>
                    {patientDrafts.length > 1 ? <div mix={css({
                      fontSize: '11px',
                      fontWeight: '500',
                      letterSpacing: '0.16em',
                      color: 'var(--color-slate-500)',
                      textTransform: 'uppercase',
                      '@media (width >= 48rem)': {
                        gridColumn: 'span 2 / span 2'
                      }
                    })}>Patient {index + 1}</div> : null}
                    <label mix={css({ minWidth: "0", ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "0.25rem" } })}><span mix={css({
                      position: 'absolute',
                      width: '1px',
                      height: '1px',
                      padding: '0',
                      margin: '-1px',
                      overflow: 'hidden',
                      clipPath: 'inset(50%)',
                      whiteSpace: 'nowrap',
                      borderWidth: '0'
                    })} data-visually-hidden="">Name</span><input aria-label="Name" aria-invalid={Boolean(props.metadataFormState?.errors.patients?.[index]?.displayName) || undefined} name={`patientDisplayName-${index}`} required maxLength={120} value={patient.displayName} mix={css({
                      display: 'block',
                      height: '2.75rem',
                      width: '100%',
                      minWidth: '0',
                      borderRadius: '18px',
                      borderStyle: 'solid',
                      borderWidth: '1px',
                      borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                      backgroundColor: 'var(--color-white)',
                      paddingInline: '0.75rem',
                      fontSize: '1rem',
                      lineHeight: '1.5',
                      fontWeight: '600',
                      color: 'var(--color-slate-950)',
                      boxShadow: 'none',
                      outlineStyle: 'none',
                      '&:focus-visible': {
                        borderColor: 'var(--ring)',
                        boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 40%, transparent)'
                      }
                    })} />{props.metadataFormState?.errors.patients?.[index]?.displayName ? <span mix={css({ display: "block", fontSize: "0.75rem", lineHeight: "1.33333333", color: "var(--color-rose-700)" })}>{props.metadataFormState.errors.patients[index]?.displayName}</span> : null}</label>
                    <label mix={css({ minWidth: "0", ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "0.25rem" } })}><span mix={css({
                      position: 'absolute',
                      width: '1px',
                      height: '1px',
                      padding: '0',
                      margin: '-1px',
                      overflow: 'hidden',
                      clipPath: 'inset(50%)',
                      whiteSpace: 'nowrap',
                      borderWidth: '0'
                    })} data-visually-hidden="">Location</span><input aria-label="Location" aria-invalid={Boolean(props.metadataFormState?.errors.patients?.[index]?.location) || undefined} name={`patientLocation-${index}`} required maxLength={120} value={patient.location} mix={css({
                      display: 'block',
                      height: '2.75rem',
                      width: '100%',
                      minWidth: '0',
                      borderRadius: '18px',
                      borderStyle: 'solid',
                      borderWidth: '1px',
                      borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                      backgroundColor: 'var(--color-white)',
                      paddingInline: '0.75rem',
                      fontSize: '0.875rem',
                      lineHeight: '1.42857143',
                      fontWeight: '500',
                      color: 'var(--color-slate-700)',
                      boxShadow: 'none',
                      outlineStyle: 'none',
                      '&:focus-visible': {
                        borderColor: 'var(--ring)',
                        boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 40%, transparent)'
                      }
                    })} />{props.metadataFormState?.errors.patients?.[index]?.location ? <span mix={css({ display: "block", fontSize: "0.75rem", lineHeight: "1.33333333", color: "var(--color-rose-700)" })}>{props.metadataFormState.errors.patients[index]?.location}</span> : null}</label>
                  </div>) : <EmptyMessage>No analyzed patient details are available for this handover yet.</EmptyMessage>}
                </div>
                <div mix={css({
                  display: 'grid',
                  gap: '1rem',
                  borderTopStyle: 'solid',
                  borderTopWidth: '1px',
                  borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                  paddingTop: '1rem',
                  '@media (width >= 48rem)': {
                    gridTemplateColumns: 'minmax(0,1.15fr) minmax(0,0.85fr)'
                  }
                })}>
                  <label mix={css({ minWidth: "0", ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "0.375rem" } })}><span mix={css({ display: "block", fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Participants</span><input aria-label="Participants" aria-invalid={Boolean(props.metadataFormState?.errors.participants) || undefined} name="participants" value={props.metadataFormState?.participants ?? participants.join(', ')} placeholder="Casey Bennett, Receiving registrar" mix={css({
                    display: 'block',
                    height: '2.75rem',
                    width: '100%',
                    minWidth: '0',
                    borderRadius: '18px',
                    borderStyle: 'solid',
                    borderWidth: '1px',
                    borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                    backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 90%, transparent)',
                    paddingInline: '0.75rem',
                    fontSize: '0.875rem',
                    lineHeight: '1.42857143',
                    fontWeight: '500',
                    color: 'var(--color-slate-900)',
                    boxShadow: 'none',
                    outlineStyle: 'none',
                    '&:focus-visible': {
                      borderColor: 'var(--ring)',
                      boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 40%, transparent)'
                    }
                  })} />{props.metadataFormState?.errors.participants ? <span mix={css({ display: "block", fontSize: "0.75rem", lineHeight: "1.33333333", color: "var(--color-rose-700)" })}>{props.metadataFormState.errors.participants}</span> : null}</label>
                  <div mix={css({ minWidth: "0", ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "0.375rem" } })}><div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Consent mode</div><div mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", fontWeight: "500", color: "var(--color-slate-900)" })}>{props.consentMode === 'agreed' ? 'Agreed' : props.consentMode || 'Not recorded'}</div></div>
                </div>
                <FrameMutationEnhancer preserveScroll />
              </form> : <>
                {showPatientScopePlaceholder ? <div mix={css({ maxWidth: "48rem" })} aria-label="Patient handover scope loading"><div mix={css({
                  height: '1.25rem',
                  width: 'min(26rem, 74%)',
                  animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                  borderRadius: '9999px',
                  backgroundColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                  '@media (width >= 40rem)': {
                    height: '1.5rem'
                  }
                })} /></div> : <div mix={css({
                  maxWidth: '48rem',
                  fontSize: '1rem',
                  lineHeight: '1.5rem',
                  fontWeight: '600',
                  color: 'var(--color-slate-950)',
                  '@media (width >= 48rem)': {
                    fontSize: '1.45rem',
                    lineHeight: '2rem'
                  }
                })}>{patientLabel}</div>}
                <div mix={css({
                  display: 'grid',
                  gap: '1rem',
                  borderTopStyle: 'solid',
                  borderTopWidth: '1px',
                  borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                  paddingTop: '1rem',
                  '@media (width >= 48rem)': {
                    gridTemplateColumns: 'minmax(0,1.15fr) minmax(0,0.85fr)'
                  }
                })}>
                  <div mix={css({ minWidth: "0", ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "0.375rem" } })}><div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Participants</div>{showParticipantsPlaceholder ? <div mix={css({ paddingBlock: "0.25rem" })} aria-label="Participants loading"><div mix={css({
                    height: '0.625rem',
                    width: '11rem',
                    animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                    borderRadius: '9999px',
                    backgroundColor: 'color-mix(in oklab, var(--color-slate-200) 75%, transparent)'
                  })} /></div> : <div mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", fontWeight: "500", color: "var(--color-slate-900)" })}>{participants.length ? participants.join(' • ') : 'Participants not identified'}</div>}</div>
                  <div mix={css({ minWidth: "0", ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "0.375rem" } })}><div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Consent mode</div><div mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", fontWeight: "500", color: "var(--color-slate-900)" })}>{props.consentMode === 'agreed' ? 'Agreed' : props.consentMode || 'Not recorded'}</div></div>
                </div>
              </>}
            </div>
          </div>
        </section>

        <ReviewActions
          extendAction={props.extendAction}
          handover={props.handover}
          restartCue={restartCues[0]?.lastConfirmedPoint}
          restartCueTitle={restartCues[0]?.title}
          restartCueSubtitle={restartCues[0]?.subtitle ?? undefined}
          restartCues={restartCues}
          inboxPlacement={props.inboxPlacement}
          assignmentAction={props.assignmentAction}
          recipients={props.recipients ?? []}
          deleteAction={props.handover.status === 'failed' ? undefined : props.deleteAction}
          csrfToken={props.csrfToken}
        />
      </div>

      <div id="review-content" mix={css({
        display: 'flex',
        minWidth: '0',
        flexDirection: 'column',
        gap: '1rem',
        '@media (width >= 48rem)': {
          minHeight: '520px',
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: '2rem'
        }
      })}>
        <ReviewNavigation tabs={props.tabs} activeTab={props.activeTab} analysis={analysis} tasks={props.tasks ?? []} />
        <section mix={css({ minHeight: "0", minWidth: "0", flex: "1" })} aria-labelledby="handover-review-title">
          <ReviewContent
            activeTab={props.activeTab}
            analysis={analysis}
            metadata={props.transcriptionMetadata ?? null}
            transcript={props.transcript ?? ''}
            transcriptPrivacy={props.transcriptPrivacy ?? null}
            transcriptPrivacyExpected={props.transcriptPrivacyExpected ?? false}
            transcriptPrivacyChecking={Boolean(props.transcriptPrivacyExpected && processing)}
            transcriptPrivacyAllowAction={props.transcriptPrivacyAllowAction}
            transcriptPrivacyAnalysisStale={props.transcriptPrivacyAnalysisStale ?? false}
            rerunAnalysisAction={props.rerunAnalysisAction}
            tasks={props.tasks ?? []}
            participants={participants}
            patientKey={props.patientKey}
            patientDisplayName={props.patientDisplayName}
            patientLocation={props.patientLocation}
            patientActionsHref={props.patientActionsHref}
            editPatientDetails={props.editPatientDetails}
            metadataAction={props.metadataAction}
            checklistAction={props.checklistAction}
            summaryAction={props.summaryAction}
            summaryReviewAction={props.summaryReviewAction}
            taskAction={props.taskAction}
            uncertaintyTaskActions={props.uncertaintyTaskActions ?? {}}
            viewerPerspective={props.viewerPerspective ?? 'receiving'}
            interactionsDisabled={props.interactionsDisabled ?? false}
            csrfToken={props.csrfToken}
          />
        </section>
      </div>
    </div>
  }
}

function ReviewActions(handle: Handle<{
  extendAction?: string
  handover: HandoverSummary
  restartCue?: string
  restartCueTitle?: string
  restartCueSubtitle?: string
  restartCues?: Array<{ id: string; title: string; subtitle?: string | null; lastConfirmedPoint: string }>
  inboxPlacement?: {
    action: string
    assignmentTitle: string
    assignedBy: string
    sourceLabel: string
    shifts: Array<{ id: string; title: string; department?: string }>
  }
  assignmentAction?: string
  recipients: DirectoryOption[]
  deleteAction?: string
  csrfToken?: string
}>) {
  return () => <section data-testid="review-actions" mix={css({
    borderRadius: '20px',
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
    backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 78%, transparent)',
    paddingInline: '0.75rem',
    paddingBlock: '0.75rem',
    '@media (width >= 48rem)': {
      borderRadius: '26px',
      paddingInline: '1.5rem',
      paddingBlock: '1rem'
    }
  })}>
    <div mix={css({
      display: 'none',
      fontSize: '11px',
      fontWeight: '500',
      letterSpacing: '0.16em',
      color: 'var(--color-slate-500)',
      textTransform: 'uppercase',
      '@media (width >= 48rem)': {
        display: 'block'
      }
    })}>Actions</div>
    <div data-testid="review-actions-grid" mix={css({ display: "grid", alignItems: "stretch", gap: "0.5rem", "@media (width >= 48rem)": { marginTop: "1rem", gridTemplateColumns: "repeat(1, minmax(0, 1fr))" } })}>
      <div data-testid="review-actions-primary-row" mix={css({
        display: 'grid',
        gridTemplateColumns: 'minmax(5.5rem,1fr) repeat(2,3.5rem)',
        alignItems: 'stretch',
        gap: '0.5rem',
        '@media (width >= 48rem)': {
          display: 'contents'
        }
      })}>
        {handle.props.extendAction ? <RecommenceHandoverButton action={handle.props.extendAction} csrfToken={handle.props.csrfToken} contextLabel={handle.props.handover.title} restartCue={handle.props.restartCue} restartCueTitle={handle.props.restartCueTitle} restartCueSubtitle={handle.props.restartCueSubtitle} restartCues={handle.props.restartCues} /> : null}
        {handle.props.inboxPlacement ? <div mix={css({ display: "none", "@media (width >= 48rem)": { display: "block" }, "&>button": { width: "100%" } })}><InboxPlacementForm {...handle.props.inboxPlacement} csrfToken={handle.props.csrfToken} /></div> : null}
        {handle.props.assignmentAction ? <SendHandoverDialog action={handle.props.assignmentAction} handoverId={handle.props.handover.id} handoverTitle={handle.props.handover.title} recipients={handle.props.recipients} csrfToken={handle.props.csrfToken} /> : null}
        {handle.props.deleteAction ? <DeleteHandoverDialog action={handle.props.deleteAction} handoverTitle={handle.props.handover.title} csrfToken={handle.props.csrfToken} /> : null}
      </div>
    </div>
  </section>
}

function ReviewNavigation(handle: Handle<{ tabs: ReviewTab[]; activeTab: string; analysis: ReviewAnalysis | null; tasks: TaskSummary[] }>) {
  return () => <div mix={css({ minWidth: "0", "@media (width >= 48rem)": { position: "sticky", top: "6rem", minWidth: "216px" } })}>
    <nav aria-label="Review tabs" mix={css({
      display: 'grid',
      gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
      columnGap: '0.25rem',
      rowGap: '0.5rem',
      borderRadius: '20px',
      borderStyle: 'solid',
      borderWidth: '1px',
      borderColor: 'color-mix(in oklab, var(--color-slate-200) 70%, transparent)',
      backgroundColor: 'color-mix(in oklab, var(--color-white) 84%, transparent)',
      padding: '0.5rem',
      boxShadow: '0 10px 24px rgba(44,56,75,0.04)',
      '@media (width >= 48rem)': {
        display: 'none'
      }
    })}>
      {handle.props.tabs.map((tab) => <ReviewTabLink key={tab.key} tab={tab} active={tab.key === handle.props.activeTab} compact analysis={handle.props.analysis} tasks={handle.props.tasks} />)}
    </nav>
    <nav aria-label="Review sections" mix={css({
      display: 'none',
      width: '100%',
      alignItems: 'stretch',
      borderRadius: '28px',
      borderStyle: 'solid',
      borderWidth: '1px',
      borderColor: 'color-mix(in oklab, var(--color-slate-200) 70%, transparent)',
      backgroundColor: 'color-mix(in oklab, var(--color-white) 62%, transparent)',
      padding: '0.5rem',
      '@media (width >= 48rem)': {
        display: 'grid'
      }
    })}>
      {handle.props.tabs.map((tab) => <ReviewTabLink key={tab.key} tab={tab} active={tab.key === handle.props.activeTab} analysis={handle.props.analysis} tasks={handle.props.tasks} />)}
    </nav>
  </div>
}

function ReviewTabLink(handle: Handle<{ tab: ReviewTab; active: boolean; compact?: boolean; analysis: ReviewAnalysis | null; tasks: TaskSummary[] }>) {
  return () => {
    let metric = handle.props.tab.disabled ? null : tabMetric(handle.props.tab.key, handle.props.analysis, handle.props.tasks)
    let summaryReviewed = !handle.props.tab.disabled && handle.props.tab.key === 'summary' && handle.props.analysis?.structuredSummary
      ? handle.props.analysis.structuredSummaryReviewed
      : null
    let metricId = metric ? `review-tab-${handle.props.tab.key}-metric` : undefined
    let reviewStatusId = summaryReviewed != null ? `review-tab-${handle.props.tab.key}-review-status` : undefined
    let describedBy = [metricId, reviewStatusId].filter(Boolean).join(' ') || undefined
    let compactStyles: Parameters<typeof css>[0] = {
      height: '3.5rem',
      minWidth: '0',
      flexDirection: 'column',
      gap: '0.25rem',
      borderRadius: '14px',
      paddingInline: '0.375rem',
      paddingTop: '0.5rem',
      paddingBottom: '0.5rem',
      textAlign: 'center',
      fontSize: '10px',
      fontWeight: '500'
    }
    let desktopStyles: Parameters<typeof css>[0] = {
      minHeight: '2.75rem',
      gap: '0.75rem',
      borderRadius: '18px',
      paddingInline: '1rem',
      paddingBlock: '0.75rem',
      paddingLeft: '1.25rem',
      textAlign: 'left',
      fontSize: '0.875rem',
      lineHeight: '1.42857143',
      fontWeight: '400'
    }
    let activeStyles: Parameters<typeof css>[0] = handle.props.tab.disabled ? {
      cursor: 'not-allowed',
      borderColor: 'transparent',
      color: 'var(--color-slate-400)',
      '& svg': {
        color: 'var(--color-slate-400)'
      }
    } : handle.props.compact ? handle.props.active ? {
      borderColor: 'transparent',
      backgroundColor: 'transparent',
      color: 'var(--color-slate-950)',
      boxShadow: 'none',
      '& svg': {
        color: 'var(--primary)'
      }
    } : {
      borderColor: 'transparent',
      color: 'var(--color-slate-600)',
      '&:hover': {
        '@media (hover: hover)': {
          color: 'var(--color-slate-950)'
        }
      },
      '& svg': {
        color: 'var(--color-slate-600)'
      }
    } : handle.props.active ? {
      borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
      backgroundColor: 'var(--color-white)',
      color: 'var(--color-slate-950)',
      boxShadow: '0 12px 28px rgba(44,56,75,0.08)',
      '& span[data-tab-meta]': {
        borderColor: 'color-mix(in oklab, var(--color-slate-300) 70%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 4%, transparent)',
        color: 'var(--color-slate-700)'
      },
      '& svg': {
        color: 'var(--color-slate-950)'
      }
    } : {
      borderColor: 'transparent',
      color: 'var(--color-slate-900)',
      '&:hover': {
        '@media (hover: hover)': {
          color: 'var(--color-slate-950)'
        }
      },
      '& svg': {
        color: 'var(--color-slate-600)'
      }
    }
    let status = summaryReviewed != null ? <ReviewTabStatus reviewed={summaryReviewed} compact={handle.props.compact} id={reviewStatusId} /> : null
    let metricNode = metric ? <><span aria-hidden="true" data-tab-meta title={metric.label} mix={css({
      ...{
        marginLeft: 'auto',
        display: 'inline-flex',
        height: '1.25rem',
        flexShrink: '0',
        alignItems: 'center',
        borderRadius: '9999px',
        borderStyle: 'solid',
        borderWidth: '1px',
        borderColor: 'color-mix(in oklab, var(--color-slate-200) 75%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 3%, transparent)',
        paddingInline: '0.5rem',
        fontSize: '11px',
        lineHeight: '1',
        fontWeight: '500',
        color: 'var(--color-slate-500)',
        fontVariantNumeric: 'tabular-nums'
      },
      ...(handle.props.compact ? {
        marginLeft: '0'
      } : {})
    })}>{metric.value}</span>{metricId ? <span id={metricId} mix={css({
      position: 'absolute',
      width: '1px',
      height: '1px',
      padding: '0',
      margin: '-1px',
      overflow: 'hidden',
      clipPath: 'inset(50%)',
      whiteSpace: 'nowrap',
      borderWidth: '0'
    })} data-visually-hidden="">{metric.label}</span> : null}</> : null
    let content = handle.props.compact ? <>
      <span mix={css({ display: "flex", minHeight: "1.25rem", alignItems: "center", justifyContent: "center", gap: "0.375rem" })}><ReviewTabIcon tab={handle.props.tab.key} />{status}{metricNode}</span>
      <span mix={css({ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: "1" })}>{handle.props.tab.label}</span>
      {handle.props.active ? <span mix={css({ position: "absolute", insetInline: "0.75rem", bottom: "0", height: "0.125rem", borderRadius: "9999px", backgroundColor: "var(--primary)" })} /> : null}
    </> : <>
      <ReviewTabIcon tab={handle.props.tab.key} />
      <span mix={css({ minWidth: "0", flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>{handle.props.tab.label}</span>
      {status}{metricNode}
    </>
    let styles: Parameters<typeof css>[0] = {
      ...{
        position: 'relative',
        display: 'inline-flex',
        minWidth: '0',
        alignItems: 'center',
        borderStyle: 'solid',
        borderWidth: '1px',
        textDecorationLine: 'none',
        transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
        transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
        transitionDuration: '150ms'
      },
      ...(handle.props.compact ? compactStyles : desktopStyles),
      ...activeStyles
    }
    return handle.props.tab.disabled
      ? <span role="link" aria-disabled="true" aria-label={handle.props.tab.label} data-testid={`review-tab-${handle.props.tab.key}`} mix={css(styles)}>{content}</span>
      : <a href={handle.props.tab.href} mix={[css(styles), link(handle.props.tab.href, { target: 'workspace', resetScroll: false })]} aria-current={handle.props.active ? 'page' : undefined} aria-label={handle.props.tab.label} aria-describedby={describedBy} data-testid={`review-tab-${handle.props.tab.key}`} >{content}</a>
  }
}

function ReviewTabStatus(handle: Handle<{ reviewed: boolean; compact?: boolean; id?: string }>) {
  return () => <><span
    aria-hidden="true"
    data-tab-review-state={handle.props.reviewed ? 'reviewed' : 'needs-review'}
    title={handle.props.reviewed ? 'SBAR summary reviewed' : 'SBAR summary needs review'}
    mix={css({
      ...{
        display: 'inline-flex',
        flexShrink: '0',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '9999px',
        borderStyle: 'solid',
        borderWidth: '1px'
      },
      ...(handle.props.compact ? {
        width: '1rem',
        height: '1rem'
      } : {
        width: '1.25rem',
        height: '1.25rem'
      }),
      ...(handle.props.reviewed ? {
        borderColor: 'color-mix(in oklab, var(--color-emerald-200) 80%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--color-emerald-500) 10%, transparent)',
        color: 'var(--color-emerald-700)'
      } : {
        borderColor: 'color-mix(in oklab, var(--color-amber-200) 80%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--color-amber-500) 10%, transparent)',
        color: 'var(--color-amber-700)'
      })
    })}
  >{handle.props.reviewed ? <CheckIcon /> : <span mix={css({ width: "0.375rem", height: "0.375rem", borderRadius: "9999px", backgroundColor: "currentcolor" })} />}</span>{handle.props.id ? <span id={handle.props.id} mix={css({
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: '0',
    margin: '-1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: '0'
  })} data-visually-hidden="">{handle.props.reviewed ? 'SBAR summary reviewed' : 'SBAR summary needs review'}</span> : null}</>
}

function ReviewContent(handle: Handle<{
  activeTab: string
  analysis: ReviewAnalysis | null
  metadata: ReviewTranscriptionMetadata | null
  transcript: string
  transcriptPrivacy: ReviewTranscriptPrivacyAudit | null
  transcriptPrivacyExpected: boolean
  transcriptPrivacyChecking: boolean
  transcriptPrivacyAllowAction?: string
  transcriptPrivacyAnalysisStale: boolean
  rerunAnalysisAction?: string
  tasks: TaskSummary[]
  participants: string[]
  patientKey?: string
  patientDisplayName?: string
  patientLocation?: string
  patientActionsHref?: string
  editPatientDetails?: boolean
  metadataAction?: string
  checklistAction?: string
  summaryAction?: string
  summaryReviewAction?: string
  taskAction?: string
  uncertaintyTaskActions: Record<string, string>
  viewerPerspective: 'receiving' | 'delivering'
  interactionsDisabled: boolean
  csrfToken?: string
}>) {
  return () => {
    let props = handle.props
    let taskPatientOptions = props.analysis?.patients.length
      ? props.analysis.patients.map((patient) => ({ key: patient.patientKey, label: `${patient.displayName}${patient.location ? ` · ${patient.location}` : ''}` }))
      : props.patientKey && props.patientDisplayName
        ? [{ key: props.patientKey, label: `${props.patientDisplayName}${props.patientLocation ? ` · ${props.patientLocation}` : ''}` }]
        : []
    if (props.activeTab === 'details') return <DetailsPanel metadata={props.metadata} />
    if (props.activeTab === 'checklist') return <ChecklistPanel items={props.analysis?.checklistFocus ?? []} action={props.checklistAction} disabled={props.interactionsDisabled} csrfToken={props.csrfToken} />
    if (props.activeTab === 'summary') return <SummaryPanel summary={props.analysis?.structuredSummary ?? null} draft={props.analysis?.structuredSummaryDraft ?? null} edits={props.analysis?.structuredSummaryEdits ?? []} reviewed={props.analysis?.structuredSummaryReviewed ?? false} action={props.summaryAction} reviewAction={props.summaryReviewAction} disabled={props.interactionsDisabled} csrfToken={props.csrfToken} />
    if (props.activeTab === 'tasks') return <TaskPanel tasks={props.tasks} action={props.taskAction} patientOptions={taskPatientOptions} patientActionsHref={props.patientActionsHref} disabled={props.interactionsDisabled} csrfToken={props.csrfToken} />
    if (props.activeTab === 'uncertainty') return <UncertaintyPanel analysis={props.analysis} metadata={props.metadata} tasks={props.tasks} taskActions={props.uncertaintyTaskActions} disabled={props.interactionsDisabled} csrfToken={props.csrfToken} />
    if (props.activeTab === 'communication') return <CommunicationPanel analysis={props.analysis} metadata={props.metadata} viewerPerspective={props.viewerPerspective} />
    if (props.activeTab === 'transcript') return <TranscriptPanel transcript={props.transcript} metadata={props.metadata} privacy={props.transcriptPrivacy} privacyExpected={props.transcriptPrivacyExpected} privacyChecking={props.transcriptPrivacyChecking} allowAction={props.transcriptPrivacyAllowAction} analysisStale={props.transcriptPrivacyAnalysisStale} rerunAction={props.rerunAnalysisAction} csrfToken={props.csrfToken} />
    return <EmptyReviewPanel title="Review unavailable" message="This review section is not available." />
  }
}

function DetailsPanel(handle: Handle<{ metadata: ReviewTranscriptionMetadata | null }>) {
  return () => {
    let noise = handle.props.metadata?.audioNoise
    let concern = noise?.backgroundNoiseConcern
    let showConcern = Boolean(concern?.message && concern.level !== 'none')
    let concernStyles: Parameters<typeof css>[0] = concern?.level === 'veryHigh' ? {
      borderColor: 'var(--color-rose-200)',
      backgroundColor: 'var(--color-rose-50)',
      color: 'var(--color-rose-950)'
    } : concern?.level === 'high' ? {
      borderColor: 'var(--color-amber-200)',
      backgroundColor: 'var(--color-amber-50)',
      color: 'var(--color-amber-950)'
    } : {
      borderColor: 'var(--color-slate-200)',
      backgroundColor: 'color-mix(in oklab, var(--color-white) 80%, transparent)',
      color: 'var(--color-slate-700)'
    }
    return <ReviewCard>
      <ReviewCardHeader><h2 mix={css({ fontFamily: "'Geist Variable', sans-serif", fontSize: "1rem", lineHeight: "1.375", fontWeight: "500" })}>Details</h2></ReviewCardHeader>
      <div mix={css({ ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "1rem" }, paddingInline: "1rem" })}>
        <div mix={css({
          borderRadius: '22px',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
          backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 74%, transparent)',
          paddingInline: '1rem',
          paddingBlock: '1rem'
        })}>
          <div mix={css({ fontSize: "0.875rem", lineHeight: "1.42857143", fontWeight: "500", color: "var(--color-slate-900)" })}>Environmental noise</div>
          {noise?.available ? <div mix={css({ marginTop: "0.75rem", ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "0.75rem" } })}>
            {showConcern ? <div role="alert" mix={css({
              ...{
                position: 'relative',
                display: 'grid',
                width: '100%',
                gap: '0.125rem',
                borderRadius: '16px',
                borderStyle: 'solid',
                borderWidth: '1px',
                paddingInline: '0.625rem',
                paddingBlock: '0.5rem',
                textAlign: 'left',
                fontSize: '0.875rem',
                lineHeight: '1.42857143'
              },
              ...(concern?.level === 'some' ? {} : {
                gridTemplateColumns: 'auto 1fr',
                columnGap: '0.5rem',
                '&>svg': {
                  translate: '0 0.125rem'
                }
              }),
              ...concernStyles
            })}>
              {concern?.level === 'some' ? null : <AlertTriangleIcon />}
              <div mix={css({ gridColumnStart: "2", display: "grid", justifyItems: "start", gap: "0.25rem", fontSize: "0.875rem", lineHeight: "1.625" })}>{concern?.message}</div>
            </div> : null}
            <section aria-label="Environmental noise metrics" mix={css({
              display: 'grid',
              gap: '0.75rem',
              borderRadius: '18px',
              borderStyle: 'solid',
              borderWidth: '1px',
              borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 70%, transparent)',
              padding: '0.75rem',
              '@media (width >= 40rem)': {
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))'
              }
            })} data-review-client-boundary="noise-metrics">
              <NoiseMetric label="Masked speech" description="The share of spoken time where the speaker was not clearly above the background noise. This is the broader measure of speech that may have been harder to hear." value={`${Math.round(noise.maskedSpeechRatio * 100)}%`} />
              <NoiseMetric label="Very low-margin speech" description="The more severe part of masked speech, where the gap between speech and background noise was especially small. This suggests the listening environment was meaningfully poor." value={`${Math.round(noise.severeLowMarginSpeechRatio * 100)}%`} />
              <NoiseMetric label="Bursts near speech" description="Short loud sounds that happened during speech or within one second of it." value={String(noise.burstsNearSpeech)} />
              <NoiseMetric label="Sustained noise" description="How much of the recording had elevated background noise over time." value={`${Math.round(noise.sustainedNoiseRatio * 100)}%`} />
              {noise.averageSpeechSnrDb != null ? <div mix={css({ "@media (width >= 40rem)": { gridColumn: "span 2 / span 2" } })}><NoiseMetric label="Speech-to-noise margin" description="Average gap between speech level and the estimated background noise floor. Higher is clearer." value={`${noise.averageSpeechSnrDb.toFixed(1)} dB`} /></div> : null}
            </section>
          </div> : <p mix={css({ marginTop: "0.5rem", fontSize: "0.875rem", lineHeight: "1.42857143", color: "var(--color-slate-500)" })}>No background noise signals captured yet.</p>}
        </div>
      </div>
    </ReviewCard>
  }
}

function ChecklistPanel(handle: Handle<{ items: ReviewChecklistItem[]; action?: string; disabled?: boolean; csrfToken?: string }>) {
  // Frame reconciles server children positionally. Keep the hydrated editor
  // below a server-owned host so its live root is removed only with that host.
  return () => <ReviewCard>
    <div mix={css({ minWidth: "0" })} data-review-client-boundary="checklist">
      <ChecklistEditor withHeader action={handle.props.action} csrfToken={handle.props.csrfToken} disabled={handle.props.disabled} items={handle.props.items.map((item) => ({ id: item.id, label: item.label, status: item.status, checked: item.status === 'addressed', detail: item.note }))} />
    </div>
  </ReviewCard>
}

function SummaryPanel(handle: Handle<{ summary: ReviewSummary | null; draft: ReviewSummary | null; edits: ReviewSummaryEdit[]; reviewed: boolean; action?: string; reviewAction?: string; disabled?: boolean; csrfToken?: string }>) {
  return () => {
    let reviewButtonStyles: Parameters<typeof css>[0] = handle.props.reviewed ? {
      borderColor: 'color-mix(in oklab, var(--color-emerald-200) 80%, transparent)',
      backgroundColor: 'color-mix(in oklab, var(--color-emerald-50) 70%, transparent)',
      color: 'var(--color-emerald-950)',
      '&:hover': {
        '@media (hover: hover)': {
          backgroundColor: 'var(--color-emerald-50)'
        }
      }
    } : {
      borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
      backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 80%, transparent)',
      color: 'var(--color-slate-950)',
      '&:hover': {
        '@media (hover: hover)': {
          backgroundColor: 'color-mix(in oklab, var(--color-slate-100) 80%, transparent)'
        }
      }
    }
    let reviewIconStyles: Parameters<typeof css>[0] = handle.props.reviewed ? {
      backgroundColor: 'color-mix(in oklab, var(--color-emerald-500) 12%, transparent)',
      color: 'var(--color-emerald-700)',
      boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-emerald-500) 20%, transparent)'
    } : {
      backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 6%, transparent)',
      color: 'var(--color-slate-600)',
      boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-950) 10%, transparent)'
    }
    let reviewStatusStyles: Parameters<typeof css>[0] = handle.props.reviewed ? {
      backgroundColor: 'color-mix(in oklab, var(--color-emerald-500) 10%, transparent)',
      color: 'var(--color-emerald-700)',
      boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-emerald-500) 20%, transparent)'
    } : {
      backgroundColor: 'color-mix(in oklab, var(--color-amber-500) 10%, transparent)',
      color: 'var(--color-amber-700)',
      boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-amber-500) 20%, transparent)'
    }
    // This distinct server root contains every hydrated summary editor while
    // Frame swaps review panels, preventing cross-panel reuse of live roots.
    return <div mix={css({ minWidth: "0" })} data-review-panel="summary"><ReviewCard>
    <ReviewCardHeader styles={{
      display: 'grid',
      gap: '1rem',
      borderBottomStyle: 'solid',
      borderBottomWidth: '1px',
      borderColor: 'color-mix(in oklab, var(--color-slate-200) 70%, transparent)',
      paddingBottom: '1.25rem',
      '@media (width >= 48rem)': {
        gridTemplateColumns: 'minmax(0,1fr) auto',
        alignItems: 'center'
      }
    }}>
      <div mix={css({ minWidth: "0", ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "0.5rem" } })}>
        <h2 mix={css({ fontFamily: "'Geist Variable', sans-serif", fontSize: "1rem", lineHeight: "1.375", fontWeight: "500" })}>Structured summary</h2>
        <p mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>Clinician edits are kept in each section’s version history.</p>
      </div>
      <div mix={css({
        display: 'flex',
        width: '100%',
        flexDirection: 'column',
        gap: '0.5rem',
        '@media (width >= 40rem)': {
          flexDirection: 'row'
        },
        '@media (width >= 48rem)': {
          width: 'auto',
          justifyContent: 'flex-end'
        }
      })}>
        {handle.props.reviewAction ? <FrameMutationForm action={handle.props.reviewAction}>{csrf(handle.props.csrfToken)}<input type="hidden" name="reviewed" value={handle.props.reviewed ? 'false' : 'true'} /><button type="submit" disabled={handle.props.disabled} aria-pressed={handle.props.reviewed} aria-label={handle.props.reviewed ? 'Mark summary as needing review' : 'Mark summary as reviewed'} mix={css({
          ...{
            display: 'inline-flex',
            height: 'auto',
            width: '100%',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.75rem',
            borderRadius: '20px',
            borderStyle: 'solid',
            borderWidth: '1px',
            paddingInline: '0.75rem',
            paddingBlock: '0.75rem',
            fontSize: '0.875rem',
            lineHeight: '1.42857143',
            fontWeight: '500',
            '&:disabled': {
              pointerEvents: 'none',
              cursor: 'not-allowed',
              opacity: '50%'
            },
            '@media (width >= 40rem)': {
              width: 'auto'
            }
          },
          ...reviewButtonStyles
        })}><span mix={css({
          ...{
            display: 'flex',
            width: '1.5rem',
            height: '1.5rem',
            flexShrink: '0',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '9999px',
            boxShadow: '0 0 0 1px currentcolor'
          },
          ...reviewIconStyles
        })}><CheckCheckIcon /></span><span mix={css({
          ...{
            display: 'inline-flex',
            height: '1.25rem',
            alignItems: 'center',
            borderRadius: '9999px',
            paddingInline: '0.5rem',
            fontSize: '0.75rem',
            lineHeight: '1.33333333',
            fontWeight: '500',
            boxShadow: '0 0 0 1px currentcolor'
          },
          ...reviewStatusStyles
        })}>{handle.props.reviewed ? 'Reviewed' : 'Needs review'}</span></button></FrameMutationForm> : null}
      </div>
    </ReviewCardHeader>
    <div mix={css({ paddingInline: "1rem", paddingTop: "1.5rem" })}>
      {handle.props.summary && handle.props.action ? <div mix={css({ display: "grid", gap: "1rem", "@media (width >= 48rem)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } })}>
        {summarySections.map((section) => {
          let value = handle.props.summary![section.key]
          let draftValue = handle.props.draft?.[section.key] ?? value
          let edited = value !== draftValue
          return <div key={section.key} data-summary-server-content={section.key} mix={css({
            borderRadius: 'calc(var(--radius) * 1.8)',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
            backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 70%, transparent)',
            padding: '1rem'
          })}>
            <div mix={css({ position: "relative" })}>
              <div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" })}>
                <span mix={css({ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" })}>
                  <span mix={css({ fontSize: "0.75rem", lineHeight: "1.33333333", fontWeight: "600", letterSpacing: "0.24em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>{section.label}</span>
                  {edited ? <span mix={css({
                    display: 'inline-flex',
                    alignItems: 'center',
                    borderRadius: '9999px',
                    borderStyle: 'solid',
                    borderWidth: '1px',
                    borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                    backgroundColor: 'color-mix(in oklab, var(--color-white) 72%, transparent)',
                    paddingInline: '0.5rem',
                    paddingBlock: '0.125rem',
                    fontSize: '10px',
                    fontWeight: '500',
                    letterSpacing: '0.12em',
                    color: 'var(--color-slate-500)',
                    textTransform: 'uppercase'
                  })}>Edited</span> : null}
                </span>
                <span aria-hidden="true" mix={css({
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.375rem',
                  borderRadius: '9999px',
                  borderStyle: 'solid',
                  borderWidth: '1px',
                  borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                  backgroundColor: 'color-mix(in oklab, var(--color-white) 80%, transparent)',
                  paddingInline: '0.625rem',
                  paddingBlock: '0.25rem',
                  fontSize: '0.75rem',
                  lineHeight: '1.33333333',
                  fontWeight: '600',
                  color: 'var(--color-slate-700)'
                })}><PencilIcon />Edit {section.label.toLowerCase()}</span>
              </div>
              <div data-summary-content mix={css({
                marginTop: '1rem',
                borderRadius: '18px',
                borderStyle: 'solid',
                borderWidth: '1px',
                borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                backgroundColor: 'color-mix(in oklab, var(--color-white) 85%, transparent)',
                paddingInline: '1rem',
                paddingBlock: '0.75rem'
              })}>
                <SummaryText value={value} list={section.key !== 'situation'} />
              </div>
              <RichTextEditor
                name="value"
                section={section.key}
                action={handle.props.action}
                csrfToken={handle.props.csrfToken}
                label={section.label}
                value={value}
                required
                disabled={handle.props.disabled}
              />
            </div>
            <SummaryRevisionHistory
              label={section.label}
              list={section.key !== 'situation'}
              draftValue={draftValue}
              currentValue={value}
              edits={handle.props.edits.filter((edit) => edit.section === section.key)}
            />
          </div>
        })}
      </div> : handle.props.summary ? <div mix={css({ display: "grid", gap: "1rem", "@media (width >= 48rem)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } })}>{summarySections.map((section) => <div key={section.key} mix={css({
        borderRadius: 'calc(var(--radius) * 1.8)',
        borderStyle: 'solid',
        borderWidth: '1px',
        borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 70%, transparent)',
        padding: '1rem'
      })}><div mix={css({ fontSize: "0.75rem", lineHeight: "1.33333333", fontWeight: "600", letterSpacing: "0.24em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>{section.label}</div><div mix={css({
        marginTop: '1rem',
        borderRadius: '18px',
        borderStyle: 'solid',
        borderWidth: '1px',
        borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--color-white) 85%, transparent)',
        paddingInline: '1rem',
        paddingBlock: '0.75rem'
      })}><SummaryText value={handle.props.summary![section.key]} list={section.key !== 'situation'} /></div></div>)}</div> : <EmptyMessage>Structured summary will appear when analysis has completed.</EmptyMessage>}
    </div>
    </ReviewCard></div>
  }
}

function SummaryRevisionHistory(handle: Handle<{
  label: string
  list: boolean
  draftValue: string
  currentValue: string
  edits: ReviewSummaryEdit[]
}>) {
  return () => {
    let versions = handle.props.edits.length
      ? [...handle.props.edits].reverse().map((edit) => ({ value: edit.previousValue, at: edit.at }))
      : handle.props.currentValue !== handle.props.draftValue
        ? [{ value: handle.props.draftValue, at: '' }]
        : []
    if (!versions.length) return null
    return <details mix={css({
      marginTop: '0.75rem',
      borderRadius: '16px',
      borderStyle: 'solid',
      borderWidth: '1px',
      borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
      backgroundColor: 'color-mix(in oklab, var(--color-white) 70%, transparent)'
    })}>
      <summary mix={css({
        display: 'flex',
        cursor: 'pointer',
        listStyleType: 'none',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.75rem',
        paddingInline: '0.75rem',
        paddingBlock: '0.5rem',
        fontSize: '0.75rem',
        lineHeight: '1.33333333',
        fontWeight: '500',
        color: 'var(--color-slate-700)'
      })}>
        <span>View version history</span>
        <span mix={css({
          display: 'inline-flex',
          minWidth: '1.25rem',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '9999px',
          backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 6%, transparent)',
          paddingInline: '0.375rem',
          paddingBlock: '0.125rem',
          fontSize: '11px',
          color: 'var(--color-slate-600)',
          boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-950) 10%, transparent)'
        })}>{versions.length}</span>
      </summary>
      <ol mix={css({
        ':where(& > :not(:last-child))': {
          marginBlockStart: '0px',
          marginBlockEnd: '0.75rem'
        },
        borderTopStyle: 'solid',
        borderTopWidth: '1px',
        borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
        padding: '0.75rem'
      })}>
        {versions.map((version, index) => <li key={`${handle.props.label}-${version.at || 'draft'}-${index}`} mix={css({ borderRadius: "14px", backgroundColor: "color-mix(in oklab, var(--color-slate-50) 90%, transparent)", padding: "0.75rem" })}>
          <div mix={css({ marginBottom: "0.5rem", fontSize: "10px", fontWeight: "600", letterSpacing: "0.14em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>{version.at ? `Before edit · ${formatTimestamp(version.at)}` : 'Original analysis'}</div>
          <SummaryText value={version.value || 'No text'} list={handle.props.list} />
        </li>)}
      </ol>
    </details>
  }
}

function TaskPanel(handle: Handle<{ tasks: TaskSummary[]; action?: string; patientOptions: Array<{ key: string; label: string }>; patientActionsHref?: string; disabled?: boolean; csrfToken?: string }>) {
  return () => <PatientActionsPanel
    tasks={handle.props.tasks}
    patientOptions={handle.props.patientOptions}
    createAction={handle.props.action}
    inlineCreate={Boolean(handle.props.action)}
    actionsHref={handle.props.patientActionsHref}
    disabled={handle.props.disabled}
    csrfToken={handle.props.csrfToken}
  />
}

function UncertaintyPanel(handle: Handle<{
  analysis: ReviewAnalysis | null
  metadata: ReviewTranscriptionMetadata | null
  tasks: TaskSummary[]
  taskActions: Record<string, string>
  disabled?: boolean
  csrfToken?: string
}>) {
  return () => {
    let uncertainties = handle.props.analysis?.patients.flatMap((patient) => patient.uncertainties.map((item) => ({
      patient,
      item,
      linkedTask: handle.props.tasks.find((task) =>
        task.patientKey === patient.patientKey && (task.relatedUncertaintyId === item.id || task.id === item.linkedTaskId),
      ) ?? null,
    }))) ?? []
    return <ReviewCard>
      <ReviewCardHeader><h2 mix={css({ display: "flex", alignItems: "center", gap: "0.5rem", fontFamily: "'Geist Variable', sans-serif", fontSize: "1rem", lineHeight: "1.375", fontWeight: "500" })}><span mix={css({ color: "var(--color-amber-600)" })}><ShieldIcon /></span>Uncertainty tracking</h2></ReviewCardHeader>
      <div mix={css({ ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "1rem" }, paddingInline: "1rem" })}>{uncertainties.length ? uncertainties.map(({ patient, item, linkedTask }) => <div key={item.id} mix={css({
        borderRadius: 'calc(var(--radius) * 1.8)',
        borderStyle: 'solid',
        borderWidth: '1px',
        borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 80%, transparent)',
        padding: '1rem'
      })}>
        <div mix={css({ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" })}>
          <div mix={css({ minWidth: "0", flex: "1" })}>
            <div mix={css({ fontSize: "0.875rem", lineHeight: "1.42857143", fontWeight: "600", letterSpacing: "0.2em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>{patient.displayName}</div>
            <div mix={css({ marginTop: "0.5rem", fontWeight: "500", color: "var(--color-slate-950)" })}>{item.statement}</div>
            <div mix={css({ marginTop: "0.5rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>{item.verificationNeed}</div>
            <TranscriptContextPanel segments={handle.props.metadata?.segments ?? []} quote={item.statement} />
          </div>
          <span mix={css({
            display: 'inline-flex',
            height: '1.25rem',
            flexShrink: '0',
            alignItems: 'center',
            borderRadius: '9999px',
            backgroundColor: 'color-mix(in oklab, var(--color-amber-500) 10%, transparent)',
            paddingInline: '0.5rem',
            fontSize: '0.75rem',
            lineHeight: '1.33333333',
            fontWeight: '500',
            color: 'var(--color-amber-700)',
            boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-amber-500) 20%, transparent)'
          })}>{item.confidence}</span>
        </div>
        <div mix={css({ marginTop: "1rem", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" })}>
          {linkedTask ? <span mix={css({
            display: 'inline-flex',
            height: '1.25rem',
            width: 'fit-content',
            flexShrink: '0',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '9999px',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'transparent',
            backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)',
            paddingInline: '0.5rem',
            paddingBlock: '0.125rem',
            fontSize: '0.75rem',
            lineHeight: '1.33333333',
            fontWeight: '500',
            whiteSpace: 'nowrap',
            color: 'var(--primary)',
            boxShadow: '0 0 0 1px color-mix(in oklab, var(--primary) 15%, transparent)'
          })}>Linked to {linkedTask.label}</span> : handle.props.taskActions[item.id] ? <FrameMutationForm action={handle.props.taskActions[item.id]}>
            {csrf(handle.props.csrfToken)}
            <input type="hidden" name="label" value={`Verify: ${item.statement.slice(0, 70)}`} />
            <input type="hidden" name="patientKey" value={patient.patientKey} />
            <input type="hidden" name="dueLabel" value="No due date set" />
            <input type="hidden" name="priority" value="routine" />
            <input type="hidden" name="status" value="open" />
            <input type="hidden" name="source" value="uncertainty" />
            <button type="submit" disabled={handle.props.disabled} mix={css({
              display: 'inline-flex',
              height: '2rem',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.375rem',
              borderRadius: 'var(--radius)',
              borderStyle: 'solid',
              borderWidth: '1px',
              borderColor: 'var(--border)',
              backgroundColor: 'var(--background)',
              paddingInline: '0.625rem',
              fontSize: '0.875rem',
              lineHeight: '1.42857143',
              fontWeight: '500',
              color: 'var(--foreground)',
              transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
              transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
              transitionDuration: '150ms',
              '&:hover': {
                '@media (hover: hover)': {
                  backgroundColor: 'var(--muted)'
                }
              },
              '&:disabled': {
                pointerEvents: 'none',
                cursor: 'not-allowed',
                opacity: '50%'
              }
            })}><ClipboardListIcon />Create verification task</button>
          </FrameMutationForm> : null}
        </div>
      </div>) : <EmptyMessage>No uncertainties were flagged in this handover.</EmptyMessage>}</div>
    </ReviewCard>
  }
}

function CommunicationPanel(handle: Handle<{
  analysis: ReviewAnalysis | null
  metadata: ReviewTranscriptionMetadata | null
  viewerPerspective: 'receiving' | 'delivering'
}>) {
  return () => {
    let analysis = handle.props.analysis
    let delivering = handle.props.viewerPerspective === 'delivering'
    let interruption = analysis?.interruptionAssessment ?? {
      status: 'none' as const,
      summary: 'Interruption assessment was not generated for this handover.',
      evidence: [],
      recommendation: 'Review the transcript directly if interruption risk is clinically relevant.',
    }
    let interruptionLabel = interruption.status === 'confirmed' ? 'Interrupted' : interruption.status === 'possible' ? 'Possible' : 'None detected'
    let interruptionTone: Parameters<typeof css>[0] = interruption.status === 'confirmed' ? {
      backgroundColor: 'var(--color-rose-50)',
      color: 'var(--color-rose-700)',
      boxShadow: '0 0 0 1px var(--color-rose-200)'
    } : interruption.status === 'possible' ? {
      backgroundColor: 'var(--color-amber-50)',
      color: 'var(--color-amber-700)',
      boxShadow: '0 0 0 1px var(--color-amber-200)'
    } : {
      backgroundColor: 'color-mix(in oklab, var(--color-white) 90%, transparent)',
      color: 'var(--color-slate-700)',
      boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-950) 10%, transparent)'
    }
    return <ReviewCard>
      <ReviewCardHeader styles={{ borderBottomStyle: "solid", borderBottomWidth: "1px", borderColor: "color-mix(in oklab, var(--color-slate-200) 80%, transparent)", paddingBottom: "1rem" }}><h2 mix={css({ display: "flex", alignItems: "center", gap: "0.5rem", fontFamily: "'Geist Variable', sans-serif", fontSize: "1rem", lineHeight: "1.375", fontWeight: "500" })}><span mix={css({ color: "var(--color-amber-600)" })}><ShieldIcon /></span>Communication</h2><p mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>{delivering ? 'Breakdowns first, then repeated points and coaching.' : 'Focus on breakdown risk and the coaching cues that may affect how this handover is received.'}</p></ReviewCardHeader>
      <div mix={css({ ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "1.5rem" }, paddingInline: "1rem" })}>
        <section mix={css({ ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "0.75rem" } })}><Eyebrow>Interruptions</Eyebrow><div mix={css({
          borderRadius: '22px',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
          backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 74%, transparent)',
          paddingInline: '1rem',
          paddingBlock: '1rem'
        })}>
          <div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" })}><div><div mix={css({ fontSize: "0.875rem", lineHeight: "1.42857143", fontWeight: "500", color: "var(--color-slate-950)" })}>Handover interruption assessment</div><p mix={css({ marginTop: "0.5rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>{interruption.summary}</p></div><span mix={css({
            ...{
              display: 'inline-flex',
              height: '1.25rem',
              alignItems: 'center',
              borderRadius: '9999px',
              paddingInline: '0.5rem',
              fontSize: '0.75rem',
              lineHeight: '1.33333333',
              fontWeight: '500',
              textTransform: 'capitalize',
              boxShadow: '0 0 0 1px currentcolor'
            },
            ...interruptionTone
          })}>{interruptionLabel}</span></div>
          {interruption.evidence.length ? <div mix={css({ marginTop: "1rem" })}><TextList title="Assessment evidence" values={interruption.evidence} emptyLabel="No interruption evidence captured." quiet /></div> : null}
          {handle.props.metadata?.interruptionSignals.length ? <div mix={css({ marginTop: "1rem" })}><TextList title="Transcript cues" values={handle.props.metadata.interruptionSignals} emptyLabel="No transcript interruption cues captured." quiet /></div> : null}
          <p mix={css({ marginTop: "1rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-700)" })}><strong mix={css({ fontWeight: "500", color: "var(--color-slate-950)" })}>Recommendation:</strong> {interruption.recommendation}</p>
        </div></section>
        <section mix={css({
          ':where(& > :not(:last-child))': {
            marginBlockStart: '0px',
            marginBlockEnd: '0.75rem'
          },
          borderTopStyle: 'solid',
          borderTopWidth: '1px',
          borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
          paddingTop: '1.25rem'
        })}><Eyebrow>Breakdown risk</Eyebrow>{analysis?.communicationRisks.length ? <div mix={css({ ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "1rem" } })}>{analysis.communicationRisks.map((risk) => <CommunicationRiskRow key={risk.id} risk={risk} />)}</div> : <p mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-500)" })}>No major communication degradation signals were flagged.</p>}</section>
        {analysis && delivering ? <>
          <section mix={css({
            ':where(& > :not(:last-child))': {
              marginBlockStart: '0px',
              marginBlockEnd: '1.25rem'
            },
            borderTopStyle: 'solid',
            borderTopWidth: '1px',
            borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
            paddingTop: '1.25rem'
          })}><Eyebrow>Feedback</Eyebrow><TextList title="Needs attention" values={analysis.feedback.needsAttention} emptyLabel="No issues captured." /><TextList title="Repeated information" values={analysis.feedback.repeatedInformation} emptyLabel="No repeated issues were flagged." /><TextList title="Coaching tips" values={analysis.feedback.coachingTips} emptyLabel="No tips captured." /></section>
          <section mix={css({
            display: 'grid',
            gap: '1.25rem',
            borderTopStyle: 'solid',
            borderTopWidth: '1px',
            borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
            paddingTop: '1.25rem',
            '@media (width >= 48rem)': {
              gridTemplateColumns: '1fr 20rem'
            }
          })}><TextList title="What worked" values={analysis.feedback.whatWorked} emptyLabel="No notes captured." quiet /><div mix={css({ ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "0.5rem" } })}><Eyebrow>Timing</Eyebrow><p mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>{analysis.feedback.durationComment}</p></div></section>
        </> : null}
      </div>
    </ReviewCard>
  }
}

type TranscriptPrivacyHighlight = {
  startCodepoint: number
  endCodepoint: number
  findings: ReviewTranscriptPrivacyFinding[]
}

type TranscriptPrivacyRenderModel = {
  audit: ReviewTranscriptPrivacyAudit
  highlights: TranscriptPrivacyHighlight[]
}

type AlignedTranscriptSegment = {
  segment: ReviewTranscriptionMetadata['segments'][number]
  startCodepoint: number
  endCodepoint: number
}

function TranscriptPanel(handle: Handle<{
  transcript: string
  metadata: ReviewTranscriptionMetadata | null
  privacy: ReviewTranscriptPrivacyAudit | null
  privacyExpected: boolean
  privacyChecking: boolean
  allowAction?: string
  analysisStale: boolean
  rerunAction?: string
  csrfToken?: string
}>) {
  return () => {
    let transcript = handle.props.transcript || 'Transcript was not available for this handover.'
    // A matching audit during recommencement belongs to an earlier completed
    // run. Do not present it as the result of the analysis still in progress.
    let privacy = handle.props.privacyChecking
      ? null
      : transcriptPrivacyRenderModel(handle.props.transcript, handle.props.privacy)
    let segments = handle.props.metadata?.segments ?? []
    let alignedSegments = privacy?.highlights.length && segments.length
      ? alignTranscriptSegments(handle.props.transcript, segments, privacy.highlights)
      : null

    return <ReviewCard>
      <ReviewCardHeader><h2 mix={css({ fontFamily: "'Geist Variable', sans-serif", fontSize: "1rem", lineHeight: "1.375", fontWeight: "500" })}>Transcript</h2></ReviewCardHeader>
      {handle.props.privacyChecking ? <TranscriptPrivacyCheckingNotice /> : null}
      {!handle.props.privacyChecking && privacy ? <TranscriptPrivacyNotice privacy={privacy.audit} analysisStale={handle.props.analysisStale} rerunAction={handle.props.rerunAction} csrfToken={handle.props.csrfToken} /> : null}
      <div mix={css({ minHeight: "0", paddingInline: "1rem" })}><div data-testid="transcript-scroll-region" mix={css({ paddingRight: "0.5rem" })}>{
        segments.length && (!privacy?.highlights.length || alignedSegments)
          ? <div mix={css({
            ':where(& > :not(:last-child))': {
              borderBottomStyle: 'solid',
              borderTopStyle: 'solid',
              borderTopWidth: '0px',
              borderBottomWidth: '1px',
              borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)'
            }
          })}>{segments.map((segment, index) => {
              let aligned = alignedSegments?.[index]
              let segmentHighlights = aligned
                ? privacy?.highlights.filter((highlight) =>
                    highlight.startCodepoint >= aligned.startCodepoint
                    && highlight.endCodepoint <= aligned.endCodepoint)
                : []
              return <article key={segment.id} mix={css({ paddingBlock: "1rem", "&:first-child": { paddingTop: "0" }, "&:last-child": { paddingBottom: "0" } })}>
                <div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: "0.5rem" })}><div mix={css({ fontSize: "0.75rem", lineHeight: "1.33333333", fontWeight: "500", color: "var(--color-slate-500)" })}>{formatTranscriptTime(segment.startMs)}</div></div>
                <div mix={css({ marginTop: "0.5rem", fontSize: "0.875rem", lineHeight: "1.75rem", overflowWrap: "break-word", whiteSpace: "pre-wrap", color: "var(--color-slate-700)" })}>{
                  aligned && segmentHighlights?.length
                    ? renderTranscriptPrivacyHighlights(segment.text, segmentHighlights, aligned.startCodepoint, handle.props.allowAction, handle.props.csrfToken)
                    : normalizeTranscriptText(segment.text)
                }</div>
              </article>
            })}</div>
          : <div mix={css({
            fontFamily: '\'Geist Variable\', sans-serif',
            fontSize: '0.875rem',
            lineHeight: '1.75rem',
            overflowWrap: 'break-word',
            whiteSpace: 'pre-wrap',
            color: 'var(--color-slate-700)'
          })}>{
              privacy?.highlights.length
                ? renderTranscriptPrivacyHighlights(handle.props.transcript, privacy.highlights, 0, handle.props.allowAction, handle.props.csrfToken)
                : normalizeTranscriptText(transcript)
            }</div>
      }</div></div>
    </ReviewCard>
  }
}

function TranscriptPrivacyCheckingNotice() {
  return () => <div data-testid="transcript-privacy-checking" role="status" aria-live="polite" mix={css({
    borderBlockStyle: 'solid',
    borderBlockWidth: '1px',
    borderColor: 'color-mix(in oklab, var(--color-sky-200) 80%, transparent)',
    backgroundColor: 'color-mix(in oklab, var(--color-sky-50) 72%, transparent)',
    paddingInline: '1rem',
    paddingBlock: '0.75rem',
    color: 'var(--color-sky-950)'
  })}>
    <div mix={css({ display: "flex", alignItems: "flex-start", gap: "0.75rem" })}>
      <span mix={css({ marginTop: "0.125rem", color: "var(--color-sky-700)" })}><ShieldIcon /></span>
      <div mix={css({ minWidth: "0" })}>
        <div mix={css({ fontSize: "0.875rem", lineHeight: "1.42857143", fontWeight: "600" })}>Checking transcript for personal information</div>
      </div>
    </div>
  </div>
}

function TranscriptPrivacyNotice(handle: Handle<{
  privacy: ReviewTranscriptPrivacyAudit
  analysisStale: boolean
  rerunAction?: string
  csrfToken?: string
}>) {
  return () => <div data-testid="transcript-privacy-notice" role="note" mix={css({
    borderBlockStyle: 'solid',
    borderBlockWidth: '1px',
    borderColor: 'color-mix(in oklab, var(--color-amber-200) 80%, transparent)',
    backgroundColor: 'color-mix(in oklab, var(--color-amber-50) 72%, transparent)',
    paddingInline: '1rem',
    paddingBlock: '0.75rem',
    color: 'var(--color-amber-950)'
  })}>
    <div mix={css({ display: "flex", alignItems: "flex-start", gap: "0.75rem" })}>
      <span mix={css({ marginTop: "0.125rem", color: "var(--color-amber-700)" })}><ShieldCheckIcon /></span>
      <div mix={css({ display: "flex", minWidth: "0", flex: "1", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" })}>
        <div mix={css({ fontSize: "0.875rem", lineHeight: "1.42857143", fontWeight: "600" })}>Personal information</div>
        {handle.props.analysisStale && handle.props.rerunAction ? <FrameMutationForm action={handle.props.rerunAction} preserveScroll wakeProcessing workflow="rerun-analysis" testId="rerun-analysis-form">
          {csrf(handle.props.csrfToken)}
          <button type="submit" mix={css({
            display: 'inline-flex',
            height: '2rem',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '9999px',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'color-mix(in oklab, var(--color-amber-300) 80%, transparent)',
            backgroundColor: 'var(--color-white)',
            paddingInline: '0.75rem',
            fontSize: '0.75rem',
            lineHeight: '1.33333333',
            fontWeight: '600',
            color: 'var(--color-amber-950)',
            transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
            transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
            transitionDuration: '150ms',
            '&:hover': {
              '@media (hover: hover)': {
                backgroundColor: 'var(--color-amber-50)'
              }
            },
            '&:focus-visible': {
              borderColor: 'var(--ring)',
              boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 40%, transparent)',
              outlineStyle: 'none'
            }
          })}>Rerun analysis</button>
        </FrameMutationForm> : null}
      </div>
    </div>
  </div>
}

function transcriptPrivacyRenderModel(
  transcript: string,
  audit: ReviewTranscriptPrivacyAudit | null,
): TranscriptPrivacyRenderModel | null {
  if (!audit || audit.replacementCount !== audit.findings.length) return null
  let codepoints = [...transcript]
  let findings = [...audit.findings].sort((left, right) =>
    left.startCodepoint - right.startCodepoint
    || left.ordinal - right.ordinal
    || left.endCodepoint - right.endCodepoint)
  if (findings.some((finding) =>
    !Number.isSafeInteger(finding.startCodepoint)
    || !Number.isSafeInteger(finding.endCodepoint)
    || finding.startCodepoint < 0
    || finding.endCodepoint <= finding.startCodepoint
    || finding.endCodepoint > codepoints.length
  )) return null

  let highlights: TranscriptPrivacyHighlight[] = []
  for (let finding of findings.filter((finding) => !finding.allowedInAnalysis)) {
    let previous = highlights.at(-1)
    if (previous && finding.startCodepoint < previous.endCodepoint) {
      previous.endCodepoint = Math.max(previous.endCodepoint, finding.endCodepoint)
      previous.findings.push(finding)
    } else {
      highlights.push({
        startCodepoint: finding.startCodepoint,
        endCodepoint: finding.endCodepoint,
        findings: [finding],
      })
    }
  }
  return { audit, highlights }
}

function alignTranscriptSegments(
  transcript: string,
  segments: ReviewTranscriptionMetadata['segments'],
  highlights: TranscriptPrivacyHighlight[],
): AlignedTranscriptSegment[] | null {
  let transcriptCodepoints = [...transcript]
  let cursor = 0
  let aligned: AlignedTranscriptSegment[] = []
  for (let segment of segments) {
    let segmentCodepoints = [...segment.text]
    let startCodepoint = findCodepointSequence(transcriptCodepoints, segmentCodepoints, cursor)
    if (startCodepoint < 0) return null
    let endCodepoint = startCodepoint + segmentCodepoints.length
    aligned.push({ segment, startCodepoint, endCodepoint })
    cursor = endCodepoint
  }
  if (highlights.some((highlight) => !aligned.some((segment) =>
    highlight.startCodepoint >= segment.startCodepoint
    && highlight.endCodepoint <= segment.endCodepoint))) return null
  return aligned
}

function findCodepointSequence(haystack: string[], needle: string[], from: number): number {
  if (!needle.length) return -1
  let lastStart = haystack.length - needle.length
  for (let start = from; start <= lastStart; start += 1) {
    if (needle.every((codepoint, offset) => haystack[start + offset] === codepoint)) return start
  }
  return -1
}

function renderTranscriptPrivacyHighlights(
  text: string,
  highlights: TranscriptPrivacyHighlight[],
  globalOffset = 0,
  allowAction?: string,
  csrfToken?: string,
): RemixNode {
  let codepoints = [...text]
  let cursor = 0
  let nodes: RemixNode[] = []
  for (let [index, highlight] of highlights.entries()) {
    let start = highlight.startCodepoint - globalOffset
    let end = highlight.endCodepoint - globalOffset
    if (start < cursor || end <= start || end > codepoints.length) continue
    if (start > cursor) nodes.push(codepoints.slice(cursor, start).join(''))
    let surface = codepoints.slice(start, end).join('')
    let labels = [...new Set(highlight.findings.map(privacyFindingLabel))]
    let details = [...new Set(highlight.findings.map((finding) => {
      let label = privacyFindingLabel(finding)
      return finding.confidence == null ? label : `${label} (${formatPrivacyConfidence(finding.confidence)} confidence)`
    }))]
    let description = `Tagged locally as ${details.join(', ')}`
    let key = `pii-${globalOffset + start}-${globalOffset + end}-${index}`
    let findingRefs = highlight.findings.map((finding) => ({
      auditId: finding.sourceAuditId,
      ordinal: finding.sourceOrdinal,
    }))
    let highlightedSurface = <>
      <mark
        data-pii-highlight
        data-pii-labels={labels.join(',')}
        title={description}
        mix={css({
          borderRadius: '4px',
          backgroundColor: 'color-mix(in oklab, var(--color-amber-200) 75%, transparent)',
          paddingInline: '0.125rem',
          color: 'var(--color-amber-950)',
          textDecorationLine: 'underline',
          textDecorationColor: 'var(--color-amber-700)',
          textDecorationThickness: '2px',
          textUnderlineOffset: '2px',
          boxShadow: 'inset 0 0 0 1px color-mix(in oklab, var(--color-amber-500) 35%, transparent)'
        })}
      ><span aria-hidden="true">{surface}</span><span mix={css({
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: '0',
        margin: '-1px',
        overflow: 'hidden',
        clipPath: 'inset(50%)',
        whiteSpace: 'nowrap',
        borderWidth: '0'
      })} data-visually-hidden="">{`${description}: ${surface}`}</span></mark>
      {highlight.findings.map((finding, findingIndex) => {
        let label = privacyFindingLabel(finding)
        let badge = `${label}${finding.confidence == null ? '' : ` · ${formatPrivacyConfidence(finding.confidence)}`}`
        if (allowAction && findingIndex === highlight.findings.length - 1) {
          return <span
            key={`pii-badge-${finding.ordinal}-${finding.startCodepoint}-${finding.endCodepoint}`}
            mix={css({
              marginInline: '0.25rem',
              display: 'inline-flex',
              translate: '0 -0.08em',
              alignItems: 'center',
              borderRadius: '9999px',
              borderStyle: 'solid',
              borderWidth: '1px',
              borderColor: 'color-mix(in oklab, var(--color-amber-300) 80%, transparent)',
              backgroundColor: 'var(--color-amber-50)',
              fontSize: '11px',
              lineHeight: '1rem',
              fontWeight: '600',
              letterSpacing: '0.04em',
              whiteSpace: 'nowrap',
              color: 'var(--color-amber-950)',
              textTransform: 'uppercase'
            })}
          >
            <span aria-hidden="true" title={badge} mix={css({ paddingBlock: "0.125rem", paddingRight: "0.25rem", paddingLeft: "0.375rem" })}>{badge}</span>
            <PrivacyFindingAllowControl
              action={allowAction}
              controlId={`${key}-allow`}
              csrfToken={csrfToken}
              findingRefs={JSON.stringify(findingRefs)}
            />
          </span>
        }
        return <span
          key={`pii-badge-${finding.ordinal}-${finding.startCodepoint}-${finding.endCodepoint}`}
          aria-hidden="true"
          title={badge}
          mix={css({
            marginInline: '0.25rem',
            display: 'inline-flex',
            translate: '0 -0.08em',
            alignItems: 'center',
            borderRadius: '9999px',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'color-mix(in oklab, var(--color-amber-300) 80%, transparent)',
            backgroundColor: 'var(--color-amber-50)',
            paddingInline: '0.375rem',
            paddingBlock: '0.125rem',
            fontSize: '11px',
            lineHeight: '1rem',
            fontWeight: '600',
            letterSpacing: '0.04em',
            whiteSpace: 'nowrap',
            color: 'var(--color-amber-950)',
            textTransform: 'uppercase'
          })}
        >{badge}</span>
      })}
    </>
    if (allowAction) {
      nodes.push(<span key={key} mix={css({ display: "inline" })} data-pii-highlight-group>{highlightedSurface}</span>)
    } else {
      nodes.push(<span key={key} mix={css({ display: "inline" })} data-pii-highlight-group>{highlightedSurface}</span>)
    }
    cursor = end
  }
  if (cursor < codepoints.length) nodes.push(codepoints.slice(cursor).join(''))
  return <>{nodes}</>
}

function privacyFindingLabel(finding: ReviewTranscriptPrivacyFinding): string {
  let value = finding.canonicalLabel || finding.label || finding.entityType || 'PII'
  return value.replace(/[_-]+/g, ' ').trim().toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatPrivacyConfidence(value: number): string {
  return `${Math.round(value * 100)}%`
}

function TranscriptContextPanel(handle: Handle<{ segments: ReviewTranscriptionMetadata['segments']; quote: string }>) {
  return () => {
    let matchIndex = bestTranscriptMatchIndex(handle.props.segments, handle.props.quote)
    if (matchIndex < 0) return <div mix={css({
      marginTop: '1rem',
      borderRadius: 'calc(var(--radius) * 1.8)',
      borderStyle: 'dashed',
      borderWidth: '1px',
      borderColor: 'var(--color-slate-300)',
      backgroundColor: 'color-mix(in oklab, var(--color-white) 70%, transparent)',
      paddingInline: '1rem',
      paddingBlock: '0.75rem',
      fontSize: '0.875rem',
      lineHeight: '1.42857143',
      color: 'var(--color-slate-500)'
    })}>Quote context was not found in the stored transcript lines.</div>
    let start = Math.max(0, matchIndex - 2)
    let context = handle.props.segments.slice(start, Math.min(handle.props.segments.length, matchIndex + 3))
    return <details data-testid="uncertainty-transcript-context" mix={css({
      marginTop: '1rem',
      borderRadius: 'calc(var(--radius) * 1.8)',
      borderStyle: 'solid',
      borderWidth: '1px',
      borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
      backgroundColor: 'color-mix(in oklab, var(--color-white) 80%, transparent)'
    })}>
      <summary mix={css({
        display: 'flex',
        cursor: 'pointer',
        listStyleType: 'none',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.75rem',
        paddingInline: '1rem',
        paddingBlock: '0.75rem'
      })}>
        <div mix={css({ fontSize: "11px", fontWeight: "600", letterSpacing: "0.22em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>View transcript context</div>
        <CountBadge>{context.length} lines</CountBadge>
      </summary>
      <div mix={css({ borderTopStyle: "solid", borderTopWidth: "1px", borderColor: "color-mix(in oklab, var(--color-slate-200) 80%, transparent)", padding: "0.75rem" })}><div mix={css({ ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "0.5rem" } })}>{context.map((segment, offset) => {
        let matched = start + offset === matchIndex
        let speaker = segment.speaker === 'giver' ? 'Giver' : segment.speaker === 'receiver' ? 'Receiver' : null
        return <div key={segment.id} mix={css({
          ...{
            borderRadius: 'calc(var(--radius) * 1.4)',
            borderStyle: 'solid',
            borderWidth: '1px',
            paddingInline: '0.75rem',
            paddingBlock: '0.5rem'
          },
          ...(matched ? {
            borderColor: 'var(--color-amber-200)',
            backgroundColor: 'color-mix(in oklab, var(--color-amber-50) 80%, transparent)'
          } : {
            borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
            backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 70%, transparent)'
          })
        })}>
          {matched || speaker ? <div mix={css({ fontSize: "11px", fontWeight: "600", letterSpacing: "0.18em", color: "var(--color-slate-400)", textTransform: "uppercase" })}>{matched ? 'Matched quote' : speaker}</div> : null}
          <div mix={css({ marginTop: "0.25rem", fontSize: "0.875rem", lineHeight: "1.5rem", overflowWrap: "break-word", whiteSpace: "pre-wrap", color: "var(--color-slate-700)" })}>{highlightTranscriptQuote(segment.text, handle.props.quote, matched)}</div>
        </div>
      })}</div></div>
    </details>
  }
}

function bestTranscriptMatchIndex(segments: ReviewTranscriptionMetadata['segments'], quote: string) {
  let normalizedQuote = normalizeTranscriptLookupText(quote)
  if (!normalizedQuote || !segments.length) return -1
  let direct = segments.findIndex((segment) => {
    let normalizedText = normalizeTranscriptLookupText(segment.text)
    return normalizedText.includes(normalizedQuote) || normalizedQuote.includes(normalizedText)
  })
  if (direct >= 0) return direct
  let tokens = normalizedQuote.split(/[^a-z0-9]+/i).filter((token) => token.length >= 4)
  if (!tokens.length) return -1
  let best = segments.reduce((current, segment, index) => {
    let text = normalizeTranscriptLookupText(segment.text)
    let score = tokens.reduce((count, token) => count + (text.includes(token) ? 1 : 0), 0)
    return score > current.score ? { index, score } : current
  }, { index: -1, score: 0 })
  return best.score >= Math.min(2, tokens.length) ? best.index : -1
}

function highlightTranscriptQuote(text: string, quote: string, wholeLine: boolean): RemixNode {
  let normalizedText = normalizeTranscriptText(text)
  let normalizedQuote = normalizeTranscriptText(quote)
  let start = normalizedText.toLowerCase().indexOf(normalizedQuote.toLowerCase())
  if (start < 0) return wholeLine ? <mark mix={css({
    borderRadius: '0.25rem',
    backgroundColor: 'color-mix(in oklab, var(--color-amber-200) 80%, transparent)',
    paddingInline: '0.125rem',
    color: 'var(--color-slate-950)'
  })}>{normalizedText}</mark> : normalizedText
  let end = start + normalizedQuote.length
  return <>{normalizedText.slice(0, start)}<mark mix={css({
    borderRadius: '0.25rem',
    backgroundColor: 'color-mix(in oklab, var(--color-amber-200) 80%, transparent)',
    paddingInline: '0.125rem',
    color: 'var(--color-slate-950)'
  })}>{normalizedText.slice(start, end)}</mark>{normalizedText.slice(end)}</>
}

function normalizeTranscriptText(value: string) { return value.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n') }
function normalizeTranscriptLookupText(value: string) { return normalizeTranscriptText(value).toLowerCase().replace(/\s+/g, ' ').trim() }

function ReviewCard(handle: Handle<{ children?: RemixNode }>) { return () => <section mix={css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  overflow: 'hidden',
  borderRadius: '24px',
  borderStyle: 'solid',
  borderWidth: '1px',
  borderColor: 'color-mix(in oklab, var(--color-white) 65%, transparent)',
  backgroundColor: 'color-mix(in oklab, var(--color-white) 84%, transparent)',
  paddingBlock: '1rem',
  fontSize: '0.875rem',
  lineHeight: '1.42857143',
  color: 'var(--card-foreground)',
  boxShadow: '0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent), 0 14px 32px rgba(44,56,75,0.05)'
})}>{handle.props.children}</section> }
function ReviewCardHeader(handle: Handle<{ children?: RemixNode; styles?: Parameters<typeof css>[0] }>) { return () => <header mix={css({ ...{ display: "grid", gridAutoRows: "min-content", alignItems: "flex-start", gap: "0.25rem", paddingInline: "1rem" }, ...(handle.props.styles ?? {  }) })}>{handle.props.children}</header> }
function EmptyReviewPanel(handle: Handle<{ title: string; message: string }>) { return () => <ReviewCard><ReviewCardHeader><h2 mix={css({ fontFamily: "'Geist Variable', sans-serif", fontSize: "1rem", lineHeight: "1.5", fontWeight: "500" })}>{handle.props.title}</h2></ReviewCardHeader><div mix={css({ paddingInline: "1rem" })}><EmptyMessage>{handle.props.message}</EmptyMessage></div></ReviewCard> }
function EmptyMessage(handle: Handle<{ children?: RemixNode }>) { return () => <div mix={css({
  borderRadius: 'calc(var(--radius) * 1.8)',
  borderStyle: 'dashed',
  borderWidth: '1px',
  borderColor: 'var(--color-slate-300)',
  backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 60%, transparent)',
  paddingInline: '1rem',
  paddingBlock: '1.25rem',
  fontSize: '0.875rem',
  lineHeight: '1.42857143',
  color: 'var(--color-slate-500)'
})}>{handle.props.children}</div> }
function CountBadge(handle: Handle<{ children?: RemixNode }>) { return () => <span mix={css({
  display: 'inline-flex',
  height: '1.25rem',
  width: 'fit-content',
  flexShrink: '0',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '9999px',
  backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 6%, transparent)',
  paddingInline: '0.5rem',
  paddingBlock: '0.125rem',
  fontSize: '0.75rem',
  lineHeight: '1.33333333',
  fontWeight: '500',
  whiteSpace: 'nowrap',
  color: 'var(--color-slate-700)',
  boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-950) 10%, transparent)'
})}>{handle.props.children}</span> }
function Eyebrow(handle: Handle<{ children?: RemixNode }>) { return () => <div mix={css({ fontSize: "0.75rem", lineHeight: "1.33333333", fontWeight: "600", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>{handle.props.children}</div> }

function TextList(handle: Handle<{ title: string; values: string[]; emptyLabel: string; quiet?: boolean }>) { return () => <section mix={css({ ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "0.625rem" } })}><div mix={css({
  ...{
    fontSize: '0.875rem',
    lineHeight: '1.42857143',
    fontWeight: '500'
  },
  ...(handle.props.quiet ? {
    color: 'var(--color-slate-700)'
  } : {
    color: 'var(--color-slate-900)'
  })
})}>{handle.props.title}</div>{handle.props.values.length ? <ul mix={css({
  listStyleType: 'disc',
  ':where(& > :not(:last-child))': {
    marginBlockStart: '0px',
    marginBlockEnd: '0.5rem'
  },
  paddingLeft: '1.25rem',
  fontSize: '0.875rem',
  lineHeight: '1.5rem',
  color: 'var(--color-slate-600)',
  '& *::marker': {
    color: 'var(--color-slate-300)'
  },
  '&::marker': {
    color: 'var(--color-slate-300)'
  },
  '& *::-webkit-details-marker': {
    color: 'var(--color-slate-300)'
  },
  '&::-webkit-details-marker': {
    color: 'var(--color-slate-300)'
  }
})}>{handle.props.values.map((value, index) => <li key={`${handle.props.title}-${index}`}>{value}</li>)}</ul> : <p mix={css({ fontSize: "0.875rem", lineHeight: "1.42857143", color: "var(--color-slate-500)" })}>{handle.props.emptyLabel}</p>}</section> }
function CommunicationRiskRow(handle: Handle<{ risk: ReviewCommunicationRisk }>) {
  return () => {
    let severityStyles: Parameters<typeof css>[0] = handle.props.risk.severity === 'high' ? {
      borderColor: 'var(--color-rose-200)',
      backgroundColor: 'var(--color-rose-50)',
      color: 'var(--color-rose-700)'
    } : handle.props.risk.severity === 'medium' ? {
      borderColor: 'var(--color-amber-200)',
      backgroundColor: 'var(--color-amber-50)',
      color: 'var(--color-amber-700)'
    } : {
      borderColor: 'var(--color-slate-200)',
      backgroundColor: 'var(--color-slate-50)',
      color: 'var(--color-slate-700)'
    }
    return <div mix={css({
      ':where(& > :not(:last-child))': {
        marginBlockStart: '0px',
        marginBlockEnd: '0.5rem'
      },
      borderLeftStyle: 'solid',
      borderLeftWidth: '1px',
      borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
      paddingLeft: '1rem'
    })}><div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" })}><div mix={css({ minWidth: "0", flex: "1" })}><div mix={css({ fontWeight: "500", color: "var(--color-slate-950)" })}>{humanize(handle.props.risk.type)}</div><p mix={css({ marginTop: "0.25rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>{handle.props.risk.evidence}</p></div><span mix={css({
      ...{
        display: 'inline-flex',
        height: '1.25rem',
        alignItems: 'center',
        borderRadius: '9999px',
        borderStyle: 'solid',
        borderWidth: '1px',
        paddingInline: '0.5rem',
        fontSize: '0.75rem',
        lineHeight: '1.33333333',
        fontWeight: '500'
      },
      ...severityStyles
    })}>{handle.props.risk.severity}</span></div><p mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-700)" })}><strong mix={css({ fontWeight: "500", color: "var(--color-slate-950)" })}>Next step:</strong> {handle.props.risk.mitigation}</p></div>
  }
}
function SummaryText(handle: Handle<{ value: string; list?: boolean }>) { return () => handle.props.list ? <ul mix={css({
  listStyleType: 'disc',
  ':where(& > :not(:last-child))': {
    marginBlockStart: '0px',
    marginBlockEnd: '0.5rem'
  },
  paddingLeft: '1.25rem',
  fontSize: '0.875rem',
  lineHeight: '1.75rem',
  color: 'var(--color-slate-700)'
})}>{statements(handle.props.value).map((item, index) => <li key={index}>{item}</li>)}</ul> : <p mix={css({ fontSize: "0.875rem", lineHeight: "1.75rem", color: "var(--color-slate-700)" })}>{handle.props.value}</p> }

function ReviewTabIcon(handle: Handle<{ tab: string }>) {
  return () => {
    if (handle.props.tab === 'checklist') return <CheckCheckIcon />
    if (handle.props.tab === 'summary') return <AudioLinesIcon />
    if (handle.props.tab === 'tasks') return <ClipboardListIcon />
    if (handle.props.tab === 'uncertainty') return <ShieldIcon />
    if (handle.props.tab === 'communication') return <BellIcon />
    if (handle.props.tab === 'transcript') return <MicIcon />
    return <MenuIcon />
  }
}

function tabMetric(tab: string, analysis: ReviewAnalysis | null, tasks: TaskSummary[]) {
  if (tab === 'checklist' && analysis?.checklistFocus.length) {
    let covered = analysis.checklistFocus.filter((item) => item.status === 'addressed').length
    let notCovered = analysis.checklistFocus.length - covered
    return { value: `${covered} | ${notCovered}`, label: `${covered} covered, ${notCovered} not covered` }
  }
  if (tab === 'tasks') return { value: String(tasks.length), label: `${tasks.length} ${tasks.length === 1 ? 'action' : 'actions'} identified` }
  if (tab === 'uncertainty' && analysis) {
    let count = analysis.patients.reduce((total, patient) => total + patient.uncertainties.length, 0)
    return { value: String(count), label: `${count} ${count === 1 ? 'uncertainty' : 'uncertainties'} identified` }
  }
  if (tab === 'communication' && analysis) {
    let count = analysis.communicationRisks.length + (analysis.interruptionAssessment?.status && analysis.interruptionAssessment.status !== 'none' ? 1 : 0)
    return { value: String(count), label: `${count} communication ${count === 1 ? 'signal' : 'signals'} identified` }
  }
  return null
}

function reviewPatients(analysis: ReviewAnalysis | null, patientKey?: string, displayName?: string, location?: string) {
  if (analysis?.patients.length) return analysis.patients
  return patientKey && displayName ? [{ patientKey, displayName, location: location ?? '' }] : []
}

function recommenceCues(
  handoverId: string,
  processingStatus: HandoverSummary['status'],
  analysis: ReviewAnalysis | null,
  metadata: ReviewTranscriptionMetadata | null,
  transcript: string,
  routeLabel?: string,
  patientKey?: string,
  patientDisplayName?: string,
) {
  let patients = processingStatus === 'completed' || analysis?.analysisReadiness.recommence
    ? analysis?.patients ?? []
    : []
  let scopedPatients = patientKey || patientDisplayName
    ? patients.filter((patient) => patient.patientKey === patientKey || patient.displayName === patientDisplayName)
    : patients
  let relevantPatients = scopedPatients.length ? scopedPatients : patients
  if (relevantPatients.length) return relevantPatients
    .map((patient) => ({
      id: patient.patientKey,
      title: patient.displayName,
      subtitle: patient.location.trim() || null,
      lastConfirmedPoint: patient.lastConfirmedPoint,
    }))

  if (!metadata?.interruptionSignals.some((signal) => signal.trim())) return []
  let normalized = normalizeTranscriptText(transcript).replace(/[ \t]+/g, ' ').replace(/\n+/g, ' ').trim()
  if (!normalized) return []
  let sentences = (normalized.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [normalized])
    .map((sentence) => sentence.trim())
    .filter(Boolean)
  let lastConfirmedPoint = sentences.slice(-2).join(' ')
  if (!lastConfirmedPoint) return []
  return [{
    id: handoverId,
    title: patientDisplayName || 'Whole handover',
    subtitle: routeLabel || null,
    lastConfirmedPoint,
  }]
}

function contextLabel(value?: string) {
  let labels: Record<string, string> = {
    'shift-handover': 'Shift to shift handover',
    'department-transfer': 'Department transfer',
    'short-transfer': 'Short transfer of care',
    'interprofessional-briefing': 'Inter-professional briefing',
    'community-transfer': 'Inpatient to community transfer',
    'transfer-of-care': 'Transfer of care',
    'clinical-update': 'Clinical update',
  }
  return value ? labels[value] ?? humanize(value) : 'Handover'
}

function formatTimestamp(value?: string) {
  if (!value) return 'recently'
  let date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function formatTranscriptTime(milliseconds: number) { let seconds = Math.max(0, Math.floor(milliseconds / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` }
function statements(value: string) { return value.split(/\n+/).map((item) => item.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean) }
function humanize(value: string) { return value.split('-').map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : '').join(' ') }
function csrf(token?: string): RemixNode { return token ? <input type="hidden" name="_csrf" value={token} /> : null }

const summarySections = [
  { key: 'situation', label: 'Situation' },
  { key: 'background', label: 'Background' },
  { key: 'assessment', label: 'Assessment' },
  { key: 'recommendation', label: 'Recommendation' },
] as const

function icon(path: RemixNode) { return <svg mix={css({ width: "1rem", height: "1rem", flexShrink: "0" })} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{path}</svg> }
function PencilIcon() { return () => icon(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>) }
function ArrowLeftIcon() { return () => icon(<><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></>) }
function CheckIcon() { return () => icon(<path d="m5 12 4 4L19 6" />) }
function CheckCheckIcon() { return () => icon(<><path d="M18 6 7 17l-5-5" /><path d="m22 10-7.5 7.5L13 16" /></>) }
function ShieldIcon() { return () => icon(<><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="M12 8v4M12 16h.01" /></>) }
function ShieldCheckIcon() { return () => icon(<><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m9 12 2 2 4-4" /></>) }
function AlertTriangleIcon() { return () => icon(<><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4M12 17h.01" /></>) }
function MicIcon() { return () => icon(<><rect width="8" height="13" x="8" y="2" rx="4" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" /></>) }
function AudioLinesIcon() { return () => icon(<><path d="M2 10v3" /><path d="M6 6v11" /><path d="M10 3v18" /><path d="M14 8v7" /><path d="M18 5v13" /><path d="M22 10v3" /></>) }
function ClipboardListIcon() { return () => icon(<><rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M12 11h4M12 16h4M8 11h.01M8 16h.01" /></>) }
function BellIcon() { return () => icon(<><path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" /></>) }
function MenuIcon() { return () => icon(<><path d="M4 5h16M4 12h16M4 19h16" /></>) }
function ChevronRightIcon() { return () => icon(<path d="m9 18 6-6-6-6" />) }
