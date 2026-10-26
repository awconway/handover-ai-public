export type WorkflowSettlement = { form: HTMLFormElement; status: 'complete' | 'error' }

export const workflowSettledEventName = 'handover:workflow-settled'

/** Lets an enhanced Remix mutation resolve the workflow attempt captured at submit. */
export function settleEnhancedWorkflow(form: HTMLFormElement, status: WorkflowSettlement['status']) {
  document.dispatchEvent(new CustomEvent<WorkflowSettlement>(workflowSettledEventName, { detail: { form, status } }))
}
