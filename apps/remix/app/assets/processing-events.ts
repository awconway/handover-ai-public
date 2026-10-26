export const PROCESSING_WAKE_EVENT = 'handover:processing-wake'

export function wakeProcessingCoordinator(): void {
  window.dispatchEvent(new CustomEvent(PROCESSING_WAKE_EVENT))
}
