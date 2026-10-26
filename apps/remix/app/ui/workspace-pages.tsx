import { css, link, type Handle } from 'remix/component'

import { DeleteShiftForm } from '../assets/delete-shift-form.tsx'
import { LocalTimestamp } from '../assets/local-timestamp.tsx'
import { NewHandoverForm } from '../assets/new-handover-form.tsx'
import { NewShiftForm } from '../assets/new-shift-form.tsx'
import { PatientActionsPanel } from '../assets/patient-actions-panel.tsx'
import { PatientHandoverDialog } from '../assets/patient-handover-dialog.tsx'
import { PatientSheetField } from '../assets/patient-sheet-field.tsx'
import { PrioritiseShiftForm } from '../assets/prioritise-shift-form.tsx'
import { ShiftPatientList } from '../assets/shift-patient-list.tsx'
import { ShiftSheetUpload } from '../assets/shift-sheet-upload.tsx'
import type { HandoverSheetField, HandoverSummary, PatientSummary, SessionSummary, ShiftSummary, TaskSummary } from './models.ts'
import { Alert } from './primitives.tsx'

export function ShiftSelectionPage(handle: Handle<{
  shifts?: ShiftSummary[]
  newShiftAction: string
  defaultTitle?: string
  defaultDepartment?: string
  assignedUserId?: string
  csrfToken?: string
  notice?: string
}>) {
  let shifts = handle.props.shifts ?? []
  return () => <div id="main-content" tabIndex={-1} mix={css({ display: "grid", gap: "1.5rem" })}>
    {handle.props.notice ? <Alert title={handle.props.notice} tone="success" /> : null}
    <section id="new-shift" mix={css({
      borderRadius: '30px',
      borderStyle: 'solid',
      borderWidth: '1px',
      borderColor: 'color-mix(in oklab, var(--color-white) 80%, transparent)',
      backgroundColor: 'color-mix(in oklab, var(--color-white) 88%, transparent)',
      padding: '1.25rem',
      boxShadow: '0 18px 40px rgba(44,56,75,0.07)'
    })}>
      <div mix={css({ display: "grid", gap: "1rem", "@media (width >= 64rem)": { gridTemplateColumns: "160px minmax(0,1fr)", alignItems: "flex-start" } })}>
        <div mix={css({ ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "0.25rem" }, paddingTop: "0.25rem" })}>
          <div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>New shift</div>
        </div>
        <div mix={css({
          borderRadius: '24px',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
          backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 82%, transparent)',
          padding: '1rem'
        })}>
          <NewShiftForm
            action={handle.props.newShiftAction}
            assignedUserId={handle.props.assignedUserId}
            csrfToken={handle.props.csrfToken}
            defaultTitle={handle.props.defaultTitle}
            defaultDepartment={handle.props.defaultDepartment}
          />
        </div>
      </div>
    </section>

    {shifts.length ? <div mix={css({
      display: 'grid',
      gap: '1rem',
      '@media (width >= 48rem)': {
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))'
      },
      '@media (width >= 80rem)': {
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))'
      }
    })}>{shifts.map((shift) => <a
      key={shift.id}
      href={shift.href}
      mix={[css({
        display: 'flex',
        height: '100%',
        flexDirection: 'column',
        borderRadius: '30px',
        borderStyle: 'solid',
        borderWidth: '1px',
        borderColor: 'color-mix(in oklab, var(--color-white) 75%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--color-white) 92%, transparent)',
        padding: '1.25rem',
        textAlign: 'left',
        color: 'var(--color-slate-950)',
        textDecorationLine: 'none',
        boxShadow: '0 18px 42px rgba(44,56,75,0.06)',
        transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
        transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
        transitionDuration: '150ms',
        '&:hover': {
          '@media (hover: hover)': {
            translate: '0 -0.125rem',
            borderColor: 'color-mix(in oklab, var(--primary) 15%, transparent)',
            boxShadow: '0 22px 50px rgba(44,56,75,0.1)'
          }
        }
      }), link(shift.href, { target: 'workspace' })]}
      data-testid={`shift-card-${shift.id}`}
      data-hover-surface=""
    >
      <div mix={css({ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" })}>
        <div mix={css({ minWidth: "0" })}>
          <div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>{shift.department ?? 'Shift'}</div>
          <div mix={css({
            marginTop: '0.5rem',
            fontFamily: '\'Geist Variable\', sans-serif',
            fontSize: '1.5rem',
            lineHeight: '1.33333333',
            fontWeight: '500',
            letterSpacing: '-0.025em',
            color: 'var(--color-slate-950)'
          })}>{shift.title}</div>
        </div>
      </div>
      <p mix={css({ marginTop: "1rem", minHeight: "3rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>{shift.notes?.trim() || 'No shift notes recorded yet.'}</p>
      <div mix={css({ marginTop: "1.25rem", display: "grid", gap: "0.75rem", "@media (width >= 40rem)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } })}>
        <div mix={css({
          borderRadius: '20px',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
          backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 90%, transparent)',
          paddingInline: '1rem',
          paddingBlock: '0.75rem'
        })}><div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Patients</div><div mix={css({ marginTop: "0.25rem", fontSize: "1.125rem", lineHeight: "1.55555556", fontWeight: "500", color: "var(--color-slate-950)" })}>{shift.patientCount ?? 0}</div></div>
        <div mix={css({
          borderRadius: '20px',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
          backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 90%, transparent)',
          paddingInline: '1rem',
          paddingBlock: '0.75rem'
        })}><div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Handovers</div><div mix={css({ marginTop: "0.25rem", fontSize: "1.125rem", lineHeight: "1.55555556", fontWeight: "500", color: "var(--color-slate-950)" })}>{shift.handoverCount ?? 0}</div></div>
      </div>
      <div mix={css({
        marginTop: '1.5rem',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.75rem',
        borderTopStyle: 'solid',
        borderTopWidth: '1px',
        borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
        paddingTop: '1rem',
        fontSize: '0.875rem',
        lineHeight: '1.42857143',
        color: 'var(--color-slate-600)'
      })}>
        <span>Started <LocalTimestamp value={shift.createdAt} /></span>
        <span mix={css({ display: "inline-flex", alignItems: "center", gap: "0.5rem", fontWeight: "500", color: "var(--color-slate-900)" })}>Open workspace <ChevronRightIcon /></span>
      </div>
    </a>)}</div> : <div mix={css({
      borderRadius: '30px',
      borderStyle: 'dashed',
      borderWidth: '1px',
      borderColor: 'var(--color-slate-300)',
      backgroundColor: 'color-mix(in oklab, var(--color-white) 70%, transparent)',
      paddingInline: '1.5rem',
      paddingBlock: '2rem',
      boxShadow: '0 16px 36px rgba(44,56,75,0.04)'
    })}><div mix={css({ maxWidth: "42rem" })}><div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>No shifts yet</div></div></div>}
  </div>
}

export function IndividualPage(handle: Handle<{
  handovers?: HandoverSummary[]
  createAction?: string
  csrfToken?: string
  shifts?: ShiftSummary[]
  session?: SessionSummary
}>) {
  let handovers = handle.props.handovers ?? []
  return () => <div id="main-content" tabIndex={-1} mix={css({ display: "grid", gap: "1.5rem" })}>
    {handle.props.createAction && handle.props.session ? <NewHandoverForm
      action={handle.props.createAction}
      uploadAction={handle.props.createAction}
      csrfToken={handle.props.csrfToken}
      mode="individual"
      shifts={handle.props.shifts}
      defaultDepartment={handle.props.session.user.department}
      defaultParticipants={[handle.props.session.user.fullName, handle.props.session.user.occupation].filter(Boolean)}
      formId="individual-handover-form"
      presentation="inline"
    /> : null}
    <section mix={css({
      borderRadius: '30px',
      borderStyle: 'solid',
      borderWidth: '1px',
      borderColor: 'color-mix(in oklab, var(--color-white) 80%, transparent)',
      backgroundColor: 'color-mix(in oklab, var(--color-white) 92%, transparent)',
      boxShadow: '0 18px 42px rgba(44,56,75,0.06)'
    })}>
      <div mix={css({
        borderBottomStyle: 'solid',
        borderBottomWidth: '1px',
        borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
        paddingInline: '1.25rem',
        paddingBlock: '1rem'
      })}><div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Previous handovers</div></div>
      {handovers.length ? <div mix={css({
        ':where(& > :not(:last-child))': {
          borderBottomStyle: 'solid',
          borderTopStyle: 'solid',
          borderTopWidth: '0px',
          borderBottomWidth: '1px',
          borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)'
        }
      })}>{handovers.map((item) => <LegacyHandoverRow key={item.id} item={item} />)}</div> : <div mix={css({ paddingInline: "1.25rem", paddingBlock: "1.5rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}><span mix={css({
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: '0',
        margin: '-1px',
        overflow: 'hidden',
        clipPath: 'inset(50%)',
        whiteSpace: 'nowrap',
        borderWidth: '0'
      })} data-visually-hidden="">No direct handovers. </span>No individual handovers yet.</div>}
    </section>
  </div>
}

export function ShiftBoardPage(handle: Handle<{
  shift: ShiftSummary
  patients?: PatientSummary[]
  createHandoverAction?: string
  importSheetAction?: string
  orderAction?: string
  prioritiseAction?: string
  deleteAction?: string
  session?: SessionSummary
  csrfToken?: string
}>) {
  let patients = handle.props.patients ?? handle.props.shift.patients ?? []
  let handoverCount = handle.props.shift.handoverCount ?? patients.reduce((count, patient) => count + (patient.handoverCount ?? patient.handovers?.length ?? 0), 0)
  let activeShiftHandovers = (handle.props.shift.handovers ?? []).filter((handover) => handover.status === 'queued' || handover.status === 'transcribing' || handover.status === 'analysing')

  return () => <div id="main-content" tabIndex={-1} mix={css({ display: "grid", gap: "1.5rem", "@media (width >= 80rem)": { gridTemplateColumns: "320px minmax(0,1fr)" } })} data-testid="shift-workspace">
    <aside mix={css({
      ':where(& > :not(:last-child))': {
        marginBlockStart: '0px',
        marginBlockEnd: '1rem'
      },
      '@media (width >= 80rem)': {
        position: 'sticky',
        top: '6rem',
        alignSelf: 'flex-start'
      }
    })}>
      <div mix={css({ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0.75rem" })}>
        <ContextMetric label="Patients" value={String(patients.length)} />
        <ContextMetric label="Handovers" value={String(handoverCount)} subtle />
      </div>

      <section mix={css({
        borderRadius: '26px',
        borderStyle: 'solid',
        borderWidth: '1px',
        borderColor: 'color-mix(in oklab, var(--color-slate-200) 70%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 78%, transparent)',
        padding: '1rem'
      })}>
        <div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Actions</div>
        <div mix={css({ marginTop: "1rem", ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "1rem" } })}>
          <div mix={css({
            borderRadius: '20px',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
            backgroundColor: 'color-mix(in oklab, var(--color-white) 84%, transparent)',
            paddingInline: '0.75rem',
            paddingBlock: '0.75rem'
          })}>
            <div mix={css({ display: "flex", alignItems: "flex-start", gap: "0.75rem" })}>
              <span mix={css({
                display: 'flex',
                width: '2.25rem',
                height: '2.25rem',
                flexShrink: '0',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '14px',
                backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)',
                color: 'var(--primary)',
                boxShadow: '0 0 0 1px color-mix(in oklab, var(--primary) 12%, transparent)'
              })}><FileTextIcon /></span>
              <div mix={css({ minWidth: "0", flex: "1" })}>
                <div mix={css({ fontSize: "0.875rem", lineHeight: "1.42857143", fontWeight: "600", color: "var(--color-slate-950)" })}>Handover sheet</div>
                <div mix={css({ marginTop: "0.25rem", fontSize: "0.75rem", lineHeight: "1.25rem", color: "var(--color-slate-600)" })}>{handle.props.shift.sheet?.fileName ?? 'No sheet imported for this shift'}</div>
              </div>
            </div>
            {handle.props.shift.sheet ? <div role="status" aria-live="polite" mix={css({
              marginTop: '0.75rem',
              borderRadius: '16px',
              borderStyle: 'solid',
              borderWidth: '1px',
              borderColor: 'var(--color-emerald-200)',
              backgroundColor: 'var(--color-emerald-50)',
              paddingInline: '0.75rem',
              paddingBlock: '0.5rem',
              fontSize: '0.75rem',
              lineHeight: '1.25rem',
              color: 'var(--color-emerald-800)'
            })}><div mix={css({ fontWeight: "500" })}>Sheet digitised</div><div>{handle.props.shift.sheet.patientCount} patient row{handle.props.shift.sheet.patientCount === 1 ? '' : 's'} digitised from the sheet.</div></div> : null}
            {handle.props.importSheetAction ? <ShiftSheetUpload action={handle.props.importSheetAction} csrfToken={handle.props.csrfToken} /> : null}
          </div>

          <div>
            <div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>New handover</div>
            <div mix={css({ marginTop: "0.75rem" })}>{handle.props.createHandoverAction && handle.props.session ? <NewHandoverForm
              action={handle.props.createHandoverAction}
              uploadAction={handle.props.createHandoverAction}
              csrfToken={handle.props.csrfToken}
              mode="shift"
              shifts={[handle.props.shift]}
              defaultDepartment={handle.props.shift.department ?? handle.props.session.user.department}
              defaultParticipants={[handle.props.session.user.fullName, handle.props.session.user.occupation].filter(Boolean)}
              defaultShiftId={handle.props.shift.id}
              formId={`shift-${handle.props.shift.id}-handover-form`}
              presentation="embedded"
            /> : null}</div>
          </div>

          <div mix={css({ display: "grid", gap: "0.5rem" })}>
            {handle.props.prioritiseAction ? <PrioritiseShiftForm action={handle.props.prioritiseAction} csrfToken={handle.props.csrfToken} disabled={patients.length < 2} /> : null}
            {handle.props.deleteAction ? <DeleteShiftForm action={handle.props.deleteAction} shiftTitle={handle.props.shift.title} csrfToken={handle.props.csrfToken} /> : null}
          </div>
        </div>
      </section>
    </aside>

    <section mix={css({ position: "relative", minWidth: "0", ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "1rem" } })}>
      {activeShiftHandovers.length ? <section aria-labelledby="shift-processing-handovers-heading" data-testid="shift-processing-handovers" mix={css({
        borderRadius: '24px',
        borderStyle: 'solid',
        borderWidth: '1px',
        borderColor: 'color-mix(in oklab, var(--primary) 15%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)',
        paddingInline: '1rem',
        paddingBlock: '1rem',
        boxShadow: '0 12px 28px rgba(44,56,75,0.05)'
      })}>
        <div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" })}>
          <div mix={css({ display: "flex", minWidth: "0", alignItems: "flex-start", gap: "0.75rem" })}><div mix={css({
            display: 'flex',
            width: '2.5rem',
            height: '2.5rem',
            flexShrink: '0',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '14px',
            backgroundColor: 'color-mix(in oklab, var(--color-white) 85%, transparent)',
            color: 'var(--primary)',
            boxShadow: '0 0 0 1px color-mix(in oklab, var(--primary) 15%, transparent)'
          })}><AudioLinesIcon /></div><div mix={css({ minWidth: "0" })}><h2 id="shift-processing-handovers-heading" mix={css({ fontSize: "0.875rem", lineHeight: "1.42857143", fontWeight: "600", color: "var(--color-slate-950)" })}>Processing handovers</h2><p mix={css({ marginTop: "0.25rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>{activeShiftHandovers.length === 1 ? '1 handover is moving through transcription, risk checks, and review finalisation.' : `${activeShiftHandovers.length} handovers are moving through transcription, risk checks, and review finalisation.`}</p></div></div>
          <span mix={css({
            display: 'inline-flex',
            height: '1.25rem',
            alignItems: 'center',
            borderRadius: 'calc(var(--radius) * 2.6)',
            backgroundColor: 'color-mix(in oklab, var(--color-white) 90%, transparent)',
            paddingInline: '0.5rem',
            paddingBlock: '0.125rem',
            fontSize: '0.75rem',
            lineHeight: '1.33333333',
            fontWeight: '500',
            color: 'var(--primary)',
            boxShadow: '0 0 0 1px color-mix(in oklab, var(--primary) 15%, transparent)'
          })}>{activeShiftHandovers.length} pending</span>
        </div>
        <div mix={css({ marginTop: "0.75rem", display: "grid", gap: "0.5rem" })}>{activeShiftHandovers.map((handover) => <a key={handover.id} href={handover.href} mix={[css({
          display: 'flex',
          minWidth: '0',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          borderRadius: '18px',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'color-mix(in oklab, var(--primary) 15%, transparent)',
          backgroundColor: 'color-mix(in oklab, var(--color-white) 82%, transparent)',
          paddingInline: '0.75rem',
          paddingBlock: '0.75rem',
          textAlign: 'left',
          color: 'var(--color-slate-950)',
          textDecorationLine: 'none',
          transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
          transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
          transitionDuration: '150ms',
          '&:hover': {
            '@media (hover: hover)': {
              borderColor: 'color-mix(in oklab, var(--primary) 25%, transparent)',
              backgroundColor: 'var(--color-white)'
            }
          },
          '&:focus-visible': {
            boxShadow: '0 0 0 2px color-mix(in oklab, var(--primary) 20%, transparent)',
            outlineStyle: 'none'
          }
        }), link(handover.href, { target: 'workspace' })]} data-processing-handover-id={handover.id} data-processing-active="true" aria-label={`Open ${handover.title} processing status`} data-hover-surface=""><span mix={css({ display: "flex", minWidth: "0", alignItems: "center", gap: "0.75rem" })}><span mix={css({
          display: 'flex',
          width: '2rem',
          height: '2rem',
          flexShrink: '0',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '9999px',
          backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)',
          color: 'var(--primary)',
          boxShadow: '0 0 0 1px color-mix(in oklab, var(--primary) 12%, transparent)'
        })}><LoadingIcon /></span><span mix={css({ minWidth: "0" })}><span mix={css({
          display: 'block',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: '0.875rem',
          lineHeight: '1.42857143',
          fontWeight: '500',
          color: 'var(--color-slate-950)'
        })}>{handover.title}</span><span mix={css({ marginTop: "0.25rem", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" })}><span mix={css({
          ...{
            display: 'inline-flex',
            height: '1.25rem',
            borderRadius: 'calc(var(--radius) * 2.6)',
            paddingInline: '0.5rem',
            paddingBlock: '0.125rem',
            fontSize: '0.75rem',
            lineHeight: '1.33333333',
            fontWeight: '500',
            boxShadow: '0 0 0 1px currentcolor'
          },
          ...processingStyles(handover.status)
        })}>{processingLabel(handover.status)}</span><span mix={css({
          display: 'inline-flex',
          height: '1.25rem',
          borderRadius: 'calc(var(--radius) * 2.6)',
          backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 5%, transparent)',
          paddingInline: '0.5rem',
          paddingBlock: '0.125rem',
          fontSize: '0.75rem',
          lineHeight: '1.33333333',
          fontWeight: '500',
          color: 'var(--color-slate-700)',
          boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-950) 8%, transparent)'
        })}>{handover.patientCount ? `${handover.patientCount} ${handover.patientCount === 1 ? 'patient' : 'patients'}` : 'Patient pending'}</span><span mix={css({ fontSize: "0.75rem", lineHeight: "1.33333333", fontWeight: "500", letterSpacing: "0.14em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Updated <LocalTimestamp value={handover.updatedAt} /></span></span><span mix={css({ marginTop: "0.25rem", display: "block", fontSize: "0.75rem", lineHeight: "1.25rem", color: "var(--color-slate-500)" })}>{processingDescription(handover.status)}</span></span></span><ChevronRightIcon styles={{
          width: '1rem',
          height: '1rem',
          flexShrink: '0',
          color: 'var(--color-slate-400)',
          transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
          transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
          transitionDuration: '150ms',
          '&:is(:where([data-hover-surface]):hover *)': {
            '@media (hover: hover)': {
              translate: '0.125rem 0',
              color: 'var(--primary)'
            }
          }
        }} /></a>)}</div>
      </section> : null}

      {patients.length ? <ShiftPatientList
        patients={patients}
        orderAction={handle.props.orderAction}
        csrfToken={handle.props.csrfToken}
      /> : <div mix={css({
        borderRadius: '28px',
        borderStyle: 'dashed',
        borderWidth: '1px',
        borderColor: 'var(--color-slate-300)',
        backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 70%, transparent)',
        paddingInline: '1.25rem',
        paddingBlock: '1.5rem',
        fontSize: '0.875rem',
        lineHeight: '1.5rem',
        color: 'var(--color-slate-500)'
      })}>{activeShiftHandovers.length ? 'Patient groups will appear when processing identifies the patient details.' : 'No patients have been added to this shift yet. Start a handover to create the first patient group.'}</div>}
    </section>
  </div>
}

export function PatientWorkspacePage(handle: Handle<{
  patient: PatientSummary
  shift: Pick<ShiftSummary, 'id' | 'title' | 'department' | 'href'>
  createHandoverAction?: string
  session?: SessionSummary
  tabs: Array<{ key: string; label: string; href: string }>
  activeTab: string
  fields?: Array<{ name: string; label: string; value?: string; multiline?: boolean }>
  sheetFields?: HandoverSheetField[]
  actions?: TaskSummary[]
  saveAction?: string
  createActionAction?: string
  actionRoute?: 'add'
  actionsHref?: string
  addActionHref?: string
  csrfToken?: string
}>) {
  let actions = handle.props.actions ?? []
  let linkedActionLabel = `${actions.length} ${actions.length === 1 ? 'action' : 'actions'} linked to ${handle.props.patient.displayName}`
  let handovers = handle.props.patient.handovers ?? []
  let processingHandovers = handle.props.patient.processingHandovers ?? []
  let patientHandovers = [...handovers, ...processingHandovers]
  let hasReceivingHandover = patientHandovers.some((handover) => handover.direction === 'incoming')
  let hasDeliveringHandover = patientHandovers.some((handover) => handover.direction === 'outgoing')
  let activeHandoverCount = [...handovers, ...processingHandovers].filter((handover) => isPatientHandoverProcessing(handover.status)).length
  let shiftHref = handle.props.shift.href
  let sheetFields: HandoverSheetField[] = handle.props.sheetFields ?? (handle.props.fields ?? []).map((field) => ({
    key: field.name,
    label: field.label,
    value: field.value,
    multiline: field.multiline,
  }))

  return () => <div id="main-content" tabIndex={-1} mix={css({ display: "grid", gap: "1.25rem" })} data-testid="shift-patient-workspace">
    <div mix={css({
      display: 'flex',
      flexDirection: 'column',
      gap: '0.75rem',
      '@media (width >= 40rem)': {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between'
      }
    })}>
      <div mix={css({ minWidth: "0" })}>
        <a href={shiftHref} mix={[css({
          marginBottom: '0.5rem',
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
          paddingInline: '0',
          fontSize: '0.875rem',
          lineHeight: '1.42857143',
          fontWeight: '500',
          whiteSpace: 'nowrap',
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
          }
        }), link(shiftHref, { target: 'workspace' })]} ><ArrowLeftIcon />Back to shift</a>
        <h1 mix={css({
          fontFamily: '\'Geist Variable\', sans-serif',
          fontSize: '1.5rem',
          lineHeight: '1.33333333',
          fontWeight: '500',
          letterSpacing: '-0.025em',
          color: 'var(--color-slate-950)'
        })}>{handle.props.patient.displayName}</h1>
        {handle.props.patient.bed ? <div mix={css({
          marginTop: '0.5rem',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '0.5rem',
          fontSize: '0.875rem',
          lineHeight: '1.42857143',
          fontWeight: '500',
          color: 'var(--color-slate-600)'
        })}>
          <span mix={css({
            display: 'inline-flex',
            height: '1.25rem',
            width: 'fit-content',
            flexShrink: '0',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'calc(var(--radius) * 2.6)',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'transparent',
            backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 6%, transparent)',
            paddingInline: '0.5rem',
            paddingBlock: '0.125rem',
            fontSize: '0.75rem',
            lineHeight: '1.33333333',
            fontWeight: '500',
            whiteSpace: 'nowrap',
            color: 'var(--color-slate-700)',
            boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-950) 10%, transparent)'
          })}>{handle.props.patient.bed}</span>
        </div> : null}
      </div>
      <div mix={css({ display: "flex", flexDirection: "column", gap: "0.5rem", "@media (width >= 40rem)": { alignItems: "flex-end" } })}>
        {handle.props.createHandoverAction && handle.props.session ? <div mix={css({ display: "flex", flexDirection: "column", gap: "0.5rem", "@media (width >= 40rem)": { flexDirection: "row" } })}>
          {!hasReceivingHandover ? <PatientHandoverDialog action={handle.props.createHandoverAction} csrfToken={handle.props.csrfToken} direction="incoming" variant="primary" patient={{ key: handle.props.patient.key, displayName: handle.props.patient.displayName, location: handle.props.patient.bed }} shift={handle.props.shift} defaultDepartment={handle.props.session.user.department} defaultParticipants={[handle.props.session.user.fullName, handle.props.session.user.occupation].filter(Boolean)} /> : null}
          <PatientHandoverDialog action={handle.props.createHandoverAction} csrfToken={handle.props.csrfToken} direction="intra-shift" variant="primary" patient={{ key: handle.props.patient.key, displayName: handle.props.patient.displayName, location: handle.props.patient.bed }} shift={handle.props.shift} defaultDepartment={handle.props.session.user.department} defaultParticipants={[handle.props.session.user.fullName, handle.props.session.user.occupation].filter(Boolean)} />
          {!hasDeliveringHandover ? <PatientHandoverDialog action={handle.props.createHandoverAction} csrfToken={handle.props.csrfToken} direction="outgoing" variant="primary" patient={{ key: handle.props.patient.key, displayName: handle.props.patient.displayName, location: handle.props.patient.bed }} shift={handle.props.shift} defaultDepartment={handle.props.session.user.department} defaultParticipants={[handle.props.session.user.fullName, handle.props.session.user.occupation].filter(Boolean)} /> : null}
        </div> : null}
      </div>
    </div>

    <div mix={css({ display: "flex", minWidth: "0", flexDirection: "column", gap: "1rem" })}>
      <PatientHandoverLog handovers={handovers} processingHandovers={processingHandovers} />

      <nav aria-label="Patient workspace tabs" mix={css({
        display: 'inline-flex',
        height: 'auto',
        minHeight: '3.5rem',
        width: '100%',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: '0.25rem',
        overflow: 'hidden',
        borderRadius: '20px',
        borderStyle: 'solid',
        borderWidth: '1px',
        borderColor: 'color-mix(in oklab, var(--color-slate-200) 70%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--color-white) 84%, transparent)',
        padding: '0.375rem',
        color: 'var(--muted-foreground)'
      })}>
        {handle.props.tabs.map((tab) => <a key={tab.key} href={tab.href} mix={[css({
          position: 'relative',
          display: 'inline-flex',
          minHeight: '2.5rem',
          flex: 'none',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.375rem',
          borderRadius: '14px',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'transparent',
          paddingInline: '0.75rem',
          paddingBlock: '0.125rem',
          fontSize: '0.875rem',
          lineHeight: '1.42857143',
          fontWeight: '500',
          whiteSpace: 'nowrap',
          color: 'color-mix(in oklab, var(--foreground) 60%, transparent)',
          textDecorationLine: 'none',
          transitionProperty: 'all',
          transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
          transitionDuration: '150ms',
          '&::after': {
            content: '""',
            position: 'absolute',
            right: '0.75rem',
            bottom: '0',
            left: '0.75rem',
            height: '0.125rem'
          },
          '&:hover': {
            '@media (hover: hover)': {
              color: 'var(--foreground)'
            }
          },
          '&:focus-visible': {
            borderColor: 'var(--ring)',
            boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
          },
          '&:where([data-state="active"]), &:where([data-active]:not([data-active="false"]))': {
            color: 'var(--color-slate-950)',
            '&::after': {
              content: '""',
              backgroundColor: 'var(--primary)'
            }
          }
        }), link(tab.href, { target: 'workspace', resetScroll: false })]} aria-current={tab.key === handle.props.activeTab ? 'page' : undefined} data-active={tab.key === handle.props.activeTab ? 'true' : undefined} >
          {tab.key === 'sheet' ? <FileTextIcon /> : <ClipboardIcon />}{tab.label}{tab.key === 'actions' ? <><span aria-hidden="true" data-tab-meta="" title={linkedActionLabel} mix={css({
            marginLeft: '0.25rem',
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
          })}>{actions.length}</span><span mix={css({
            position: 'absolute',
            width: '1px',
            height: '1px',
            padding: '0',
            margin: '-1px',
            overflow: 'hidden',
            clipPath: 'inset(50%)',
            whiteSpace: 'nowrap',
            borderWidth: '0'
          })} data-visually-hidden="">{linkedActionLabel}</span></> : null}
        </a>)}
      </nav>

      {handle.props.activeTab === 'sheet' ? <div mix={css({ display: "grid", minWidth: "0", gap: "1rem" })}>
        <section mix={css({
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
          overflow: 'hidden',
          borderRadius: '24px',
          backgroundColor: 'color-mix(in oklab, var(--color-white) 88%, transparent)',
          paddingBlock: '1rem',
          fontSize: '0.875rem',
          lineHeight: '1.42857143',
          color: 'var(--card-foreground)',
          boxShadow: '0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent)'
        })} data-testid="patient-sheet-table">
          {activeHandoverCount ? <header mix={css({
            display: 'flex',
            alignItems: 'center',
            borderTopLeftRadius: 'calc(var(--radius) * 1.4)',
            borderTopRightRadius: 'calc(var(--radius) * 1.4)',
            borderBottomStyle: 'solid',
            borderBottomWidth: '1px',
            borderColor: 'color-mix(in oklab, var(--color-slate-200) 70%, transparent)',
            paddingInline: '1rem',
            paddingBottom: '1.25rem'
          })}>
            <span mix={css({
              display: 'inline-flex',
              height: '1.25rem',
              width: 'fit-content',
              flexShrink: '0',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 'calc(var(--radius) * 2.6)',
              borderStyle: 'solid',
              borderWidth: '1px',
              borderColor: 'transparent',
              backgroundColor: 'color-mix(in oklab, var(--color-amber-500) 10%, transparent)',
              paddingInline: '0.5rem',
              paddingBlock: '0.125rem',
              fontSize: '0.75rem',
              lineHeight: '1.33333333',
              fontWeight: '500',
              whiteSpace: 'nowrap',
              color: 'var(--color-amber-800)',
              boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-amber-500) 15%, transparent)'
            })}>Update processing</span>
          </header> : null}
          <div mix={css({ paddingInline: "1rem", paddingTop: "0" })}>
            <div mix={css({
              overflow: 'hidden',
              borderBottomRightRadius: '22px',
              borderBottomLeftRadius: '22px',
              borderInlineStyle: 'solid',
              borderInlineWidth: '1px',
              borderBottomStyle: 'solid',
              borderBottomWidth: '1px',
              borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
              backgroundColor: 'var(--color-white)'
            })}>
              <div mix={css({
                display: 'none',
                gridTemplateColumns: 'minmax(9rem,0.75fr) minmax(0,1.8fr) 3rem',
                borderBottomStyle: 'solid',
                borderBottomWidth: '1px',
                borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 80%, transparent)',
                paddingInline: '1rem',
                paddingBlock: '0.75rem',
                fontSize: '11px',
                fontWeight: '600',
                letterSpacing: '0.16em',
                color: 'var(--color-slate-500)',
                textTransform: 'uppercase',
                '@media (width >= 48rem)': {
                  display: 'grid'
                }
              })}><div>Field</div><div>Current value</div><div /></div>
              <div mix={css({
                ':where(& > :not(:last-child))': {
                  borderBottomStyle: 'solid',
                  borderTopStyle: 'solid',
                  borderTopWidth: '0px',
                  borderBottomWidth: '1px',
                  borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)'
                }
              })}>{sheetFields.map((field) => <PatientSheetField
                key={field.key}
                fieldKey={field.key}
                label={field.label}
                value={field.value}
                editValue={field.editValue}
                hasCapturedValue={field.hasCapturedValue}
                reviewStatus={field.reviewStatus}
                alternatives={field.alternatives}
                reviewEvents={field.reviewEvents}
                sbarUpdateEvents={field.sbarUpdateEvents}
                action={field.reviewAction ?? handle.props.saveAction}
                csrfToken={handle.props.csrfToken}
              />)}</div>
            </div>
          </div>
        </section>
      </div> : <PatientActionsPanel
        patient={handle.props.patient}
        tasks={actions}
        createAction={handle.props.createActionAction}
        actionRoute={handle.props.actionRoute}
        actionsHref={handle.props.actionsHref}
        addActionHref={handle.props.addActionHref}
        csrfToken={handle.props.csrfToken}
      />}
    </div>
  </div>
}

function PatientHandoverLog(handle: Handle<{
  handovers: HandoverSummary[]
  processingHandovers: HandoverSummary[]
}>) {
  let handovers = handle.props.handovers
  let processingHandovers = handle.props.processingHandovers

  return () => <section mix={css({ minWidth: "0", fontSize: "0.875rem", lineHeight: "1.42857143", color: "var(--card-foreground)" })} data-testid="patient-handover-log">
    <div mix={css({ minWidth: "0" })}>
      {processingHandovers.length ? <section aria-label="Processing handovers" mix={css({ display: "grid", gap: "0.5rem" })}>
        <div role="status" mix={css({
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '0.75rem',
          borderRadius: '18px',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'color-mix(in oklab, var(--primary) 15%, transparent)',
          backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)',
          paddingInline: '0.75rem',
          paddingBlock: '0.75rem'
        })}>
          <div><h3 mix={css({ fontSize: "0.875rem", lineHeight: "1.42857143", fontWeight: "600", color: "var(--color-slate-950)" })}>Processing handovers</h3><p mix={css({ marginTop: "0.25rem", fontSize: "0.75rem", lineHeight: "1.25rem", color: "var(--color-slate-600)" })}>{processingHandovers.length === 1 ? '1 handover is in the queue or processing for this patient.' : `${processingHandovers.length} handovers are in the queue or processing for this patient.`}</p></div>
          <span mix={css({
            display: 'inline-flex',
            height: '1.25rem',
            width: 'fit-content',
            flexShrink: '0',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'calc(var(--radius) * 2.6)',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'transparent',
            backgroundColor: 'color-mix(in oklab, var(--color-white) 90%, transparent)',
            paddingInline: '0.5rem',
            paddingBlock: '0.125rem',
            fontSize: '0.75rem',
            lineHeight: '1.33333333',
            fontWeight: '500',
            whiteSpace: 'nowrap',
            color: 'var(--primary)',
            boxShadow: '0 0 0 1px color-mix(in oklab, var(--primary) 15%, transparent)'
          })}>{processingHandovers.length} pending</span>
        </div>
        <div mix={css({ display: "grid", gap: "0.5rem" })}>{processingHandovers.map((handover) => <PatientHandoverLogEntry key={handover.id} handover={handover} processing />)}</div>
      </section> : null}
      {handovers.length ? <div mix={css({
        ...{
          display: 'grid',
          gap: '0.5rem',
          '@media (width >= 48rem)': {
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))'
          }
        },
        ...(processingHandovers.length ? {
          marginTop: '0.75rem'
        } : {})
      })}>{handovers.map((handover) => <PatientHandoverLogEntry key={handover.id} handover={handover} />)}</div> : null}
      {!handovers.length && !processingHandovers.length ? <div mix={css({
        borderRadius: '18px',
        borderStyle: 'dashed',
        borderWidth: '1px',
        borderColor: 'var(--color-slate-300)',
        backgroundColor: 'color-mix(in oklab, var(--color-white) 72%, transparent)',
        paddingInline: '1rem',
        paddingBlock: '1rem',
        fontSize: '0.875rem',
        lineHeight: '1.5rem',
        color: 'var(--color-slate-600)'
      })}>This patient has a digitised sheet row, but no verbal handover has been added yet.</div> : null}
    </div>
  </section>
}

function PatientHandoverLogEntry(handle: Handle<{ handover: HandoverSummary; processing?: boolean }>) {
  let item = handle.props.handover
  let showStatus = Boolean(item.status && item.status !== 'completed')
  return () => <a href={item.href} mix={[css({
    display: 'block',
    borderRadius: '20px',
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
    backgroundColor: 'var(--color-white)',
    paddingInline: '0.75rem',
    paddingBlock: '0.75rem',
    textAlign: 'left',
    color: 'var(--color-slate-950)',
    textDecorationLine: 'none',
    transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    transitionDuration: '150ms',
    '&:hover': {
      '@media (hover: hover)': {
        borderColor: 'color-mix(in oklab, var(--primary) 15%, transparent)',
        backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)'
      }
    },
    '&:focus-visible': {
      boxShadow: '0 0 0 2px color-mix(in oklab, var(--primary) 20%, transparent)',
      outlineStyle: 'none'
    }
  }), link(item.href, { target: 'workspace' })]} data-processing-handover-id={handle.props.processing ? item.id : undefined} data-processing-active={handle.props.processing ? 'true' : undefined} data-hover-surface="">
    <div mix={css({ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" })}>
      <div mix={css({ display: "flex", minWidth: "0", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" })}>
        <span mix={css({
          display: 'inline-flex',
          height: '1.25rem',
          width: 'fit-content',
          flexShrink: '0',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 'calc(var(--radius) * 2.6)',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'transparent',
          backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 6%, transparent)',
          paddingInline: '0.5rem',
          paddingBlock: '0.125rem',
          fontSize: '0.75rem',
          lineHeight: '1.33333333',
          fontWeight: '500',
          whiteSpace: 'nowrap',
          color: 'var(--color-slate-700)',
          boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-950) 10%, transparent)'
        })}>{patientDirectionLabel(item.direction)}</span>
        {showStatus ? <span mix={css({
          ...{
            display: 'inline-flex',
            height: '1.25rem',
            width: 'fit-content',
            flexShrink: '0',
            alignItems: 'center',
            justifyContent: 'center',
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
            boxShadow: '0 0 0 1px currentcolor'
          },
          ...processingStyles(item.status)
        })}>{processingLabel(item.status)}</span> : null}
      </div>
      <ChevronRightIcon styles={{
        width: '1rem',
        height: '1rem',
        flexShrink: '0',
        color: 'var(--color-slate-400)',
        transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
        transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
        transitionDuration: '150ms',
        '&:is(:where([data-hover-surface]):hover *)': {
          '@media (hover: hover)': {
            translate: '0.125rem 0',
            color: 'var(--color-slate-600)'
          }
        }
      }} />
    </div>
    <div mix={css({ marginTop: "0.75rem", fontSize: "0.875rem", lineHeight: "1.25rem", fontWeight: "500", color: "var(--color-slate-900)" })}>{item.title}</div>
    <div mix={css({
      marginTop: '0.25rem',
      fontSize: '0.75rem',
      lineHeight: '1.33333333',
      fontWeight: '500',
      letterSpacing: '0.16em',
      color: 'var(--color-slate-500)',
      textTransform: 'uppercase'
    })}>Updated <LocalTimestamp value={item.updatedAt ?? item.createdAt} /></div>
    {handle.props.processing ? <div mix={css({ marginTop: "0.5rem", fontSize: "0.75rem", lineHeight: "1.25rem", color: "var(--color-slate-600)" })}>{processingDescription(item.status)}</div> : null}
  </a>
}

function LegacyHandoverRow(handle: Handle<{ item: HandoverSummary }>) {
  return () => <a href={handle.props.item.href} mix={[css({
    display: 'flex',
    width: '100%',
    flexDirection: 'column',
    gap: '0.5rem',
    paddingInline: '1.25rem',
    paddingBlock: '1rem',
    textAlign: 'left',
    color: 'var(--color-slate-950)',
    textDecorationLine: 'none',
    transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    transitionDuration: '150ms',
    '&:hover': {
      '@media (hover: hover)': {
        backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 80%, transparent)'
      }
    }
  }), link(handle.props.item.href, { target: 'workspace' })]} data-testid={`handover-row-${handle.props.item.id}`} >
    <div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" })}>
      <div mix={css({ minWidth: "0" })}><div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>{handle.props.item.createdAt ? <LocalTimestamp value={handle.props.item.createdAt} /> : handle.props.item.direction ?? 'Handover'}</div><div mix={css({ marginTop: "0.25rem", fontSize: "1rem", lineHeight: "1.5", fontWeight: "500", color: "var(--color-slate-950)" })}>{handle.props.item.title}</div></div>
      <span mix={css({ display: 'flex', alignItems: 'center', gap: '0.75rem' })}>
        {handle.props.item.status && handle.props.item.status !== 'completed' && handle.props.item.status !== 'draft' ? <span
          data-processing-status={handle.props.item.status}
          mix={css({
            display: 'inline-flex',
            borderRadius: '9999px',
            paddingInline: '0.5rem',
            paddingBlock: '0.125rem',
            fontSize: '0.75rem',
            fontWeight: '500',
            whiteSpace: 'nowrap',
            ...processingStyles(handle.props.item.status),
          })}
        >{processingLabel(handle.props.item.status)}</span> : null}
        <ChevronRightIcon />
      </span>
    </div>
    <div mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>{handle.props.item.subtitle ?? 'Open handover workspace'}</div>
  </a>
}

function ContextMetric(handle: Handle<{ label: string; value: string; subtle?: boolean }>) {
  return () => <div mix={css({
    ...{
      borderRadius: '22px',
      borderStyle: 'solid',
      borderWidth: '1px',
      paddingInline: '1rem',
      paddingBlock: '1rem'
    },
    ...(handle.props.subtle ? {
      borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
      backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 80%, transparent)'
    } : {
      borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
      backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 90%, transparent)'
    })
  })}><div mix={css({ fontSize: "0.75rem", lineHeight: "1.33333333", fontWeight: "600", letterSpacing: "0.24em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>{handle.props.label}</div><div mix={css({ marginTop: "0.5rem", fontSize: "0.875rem", lineHeight: "1.5rem", fontWeight: "500", color: "var(--color-slate-950)" })}>{handle.props.value}</div></div>
}

function processingLabel(status?: HandoverSummary['status']) {
  if (status === 'failed') return 'Processing failed'
  if (status === 'transcribing') return 'Transcribing'
  if (status === 'analysing') return 'Analysing'
  return 'Queued'
}

function processingDescription(status?: HandoverSummary['status']) {
  if (status === 'failed') return 'Processing stopped before the review was ready. Open the handover to retry or inspect details.'
  if (status === 'transcribing') return 'Transcribing the handover so analysis can begin.'
  if (status === 'analysing') return 'Extracting the summary, checking risks, and finalising review sections.'
  return 'Queued for transcription and analysis. This will continue automatically.'
}

function processingStyles(status?: HandoverSummary['status']) : Parameters<typeof css>[0] {
  if (status === 'failed') return { backgroundColor: "color-mix(in oklab, var(--color-rose-500) 10%, transparent)", color: "var(--color-rose-700)", boxShadow: "0 0 0 1px color-mix(in oklab, var(--color-rose-500) 15%, transparent)" }
  return { backgroundColor: "color-mix(in oklab, var(--primary) 10%, transparent)", color: "var(--primary)", boxShadow: "0 0 0 1px color-mix(in oklab, var(--primary) 15%, transparent)" }
}

function isPatientHandoverProcessing(status?: HandoverSummary['status']) {
  return Boolean(status && status !== 'completed' && status !== 'failed')
}

function patientDirectionLabel(direction?: HandoverSummary['direction']) {
  if (direction === 'outgoing') return 'delivering'
  if (direction === 'intra-shift') return 'intra-shift'
  return 'receiving'
}


function ChevronRightIcon(handle: Handle<{ styles?: Parameters<typeof css>[0] }>) { return () => <svg viewBox="0 0 24 24" aria-hidden="true" mix={css(handle.props.styles ?? { width: "1rem", height: "1rem", flexShrink: "0", color: "var(--color-slate-400)", transitionProperty: "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events", transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)", transitionDuration: "150ms", "&:is(:where([data-hover-surface]):hover *)": { "@media (hover: hover)": { translate: "0.125rem 0" } } })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6" /></svg> }
function FileTextIcon() { return () => <svg viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8M8 17h8" /></svg> }
function ClipboardIcon() { return () => <svg viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 12h6M9 16h6" /></svg> }
function ArrowLeftIcon() { return () => <svg viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7M19 12H5" /></svg> }
function AudioLinesIcon() { return () => <svg viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3" /></svg> }
function LoadingIcon() { return () => <svg viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem", animation: "spin 1s linear infinite" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.6" /></svg> }
