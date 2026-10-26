export type UserSummary = {
  id: string
  fullName: string
  occupation: string
  department: string
}

export type SessionSummary = { user: UserSummary }

export type HandoverSummary = {
  id: string
  shiftId?: string
  title: string
  subtitle?: string
  status?: 'queued' | 'transcribing' | 'analysing' | 'completed' | 'failed' | 'draft'
  direction?: 'incoming' | 'intra-shift' | 'outgoing'
  createdAt?: string
  updatedAt?: string
  patientCount?: number
  href: string
  assignmentId?: string
  assignedBy?: string
  assignedAt?: string
  routeLabel?: string
  sourceShiftTitle?: string
  sourceShiftDepartment?: string
  placeAction?: string
  addToIndividualAction?: string
  dismissAction?: string
}

export type PatientSummary = {
  key: string
  displayName: string
  bed?: string
  priority?: 'high' | 'medium' | 'routine'
  status?: string
  handoverCount?: number
  latestHandoverId?: string
  openTaskCount?: number
  hasSheet?: boolean
  editAction?: string
  editableHandoverId?: string
  href: string
  handovers?: HandoverSummary[]
  processingHandovers?: HandoverSummary[]
}

export type ShiftSummary = {
  id: string
  title: string
  department?: string
  notes?: string
  createdAt?: string
  patientCount?: number
  handoverCount?: number
  href: string
  patients?: PatientSummary[]
  handovers?: HandoverSummary[]
  sheet?: {
    fileName: string
    importedAt?: string
    patientCount: number
  }
}

export type TaskSummary = {
  id: string
  label: string
  completed: boolean
  due?: string
  dueAt?: string
  priority?: 'routine' | 'urgent'
  reminderEnabled?: boolean
  updateAction?: string
  deleteAction?: string
  handoverId?: string
  handoverDirection?: 'incoming' | 'intra-shift' | 'outgoing'
  handoverUpdatedAt?: string
  patientKey?: string
  relatedUncertaintyId?: string
}

export type DirectoryOption = { id: string; label: string; description?: string }

export type HandoverSheetField = {
  key: string
  label: string
  value?: string
  editValue?: string
  hasCapturedValue?: boolean
  confidence?: 'high' | 'medium' | 'low'
  status?: 'pending' | 'accepted' | 'edited' | 'rejected'
  reviewStatus?: 'automatic' | 'needs_review' | 'human_verified' | 'llm_adjudicated'
  reviewMethod?: 'automatic' | 'human' | 'llm'
  uncertain?: boolean
  issues?: string[]
  imageQualityIssues?: string[]
  alternatives?: string[]
  reviewEvents?: Array<{
    at: string
    byUserId: string
    previousValue: string
    nextValue: string
    method: 'human' | 'llm' | 'automatic'
  }>
  sbarUpdateEvents?: Array<{
    at: string
    handoverId: string
    handoverTitle: string
    sbarSection: 'situation' | 'background' | 'assessment' | 'recommendation'
    previousValue: string
    nextValue: string
    summaryQuote: string
    rationale: string
    sourceHref?: string
  }>
  reviewAction?: string
  multiline?: boolean
}
