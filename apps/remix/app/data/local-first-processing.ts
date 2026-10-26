export const LOCAL_FIRST_PROCESSING_POLICY_ENV = 'LOCAL_FIRST_PROCESSING_POLICY'

export const localFirstProcessingPolicies = ['disabled', 'optional', 'required'] as const
export type LocalFirstProcessingPolicy = (typeof localFirstProcessingPolicies)[number]

export const privacyModes = ['cloud', 'local-first'] as const
export type PrivacyMode = (typeof privacyModes)[number]

export const currentPrivacyPolicyVersion = 1 as const

/**
 * Preserve the existing cloud pipeline when the setting is absent. A present
 * but unknown value is a configuration error: silently treating a misspelled
 * `required` as `disabled` would fail open across the cloud boundary.
 */
export function resolveLocalFirstProcessingPolicy(
  configured: string | undefined = process.env[LOCAL_FIRST_PROCESSING_POLICY_ENV],
): LocalFirstProcessingPolicy {
  let normalized = configured?.trim().toLowerCase()
  if (!normalized) return 'disabled'
  if (localFirstProcessingPolicies.includes(normalized as LocalFirstProcessingPolicy)) {
    return normalized as LocalFirstProcessingPolicy
  }
  throw new Error(
    `${LOCAL_FIRST_PROCESSING_POLICY_ENV} must be disabled, optional, or required.`,
  )
}

export function isLocalFirstProcessingPreferenceEditable(
  policy: LocalFirstProcessingPolicy,
): boolean {
  return policy === 'optional'
}

export function resolveEffectiveProcessingMode(input: {
  policy: LocalFirstProcessingPolicy
  userEnabled?: boolean | null
  localFirstHistory?: boolean
}): PrivacyMode {
  // Once a handover has crossed the local-first boundary, continuations must
  // stay local-first even when another user has a different current toggle.
  if (input.policy === 'required' || input.localFirstHistory === true) return 'local-first'
  if (input.policy === 'optional' && input.userEnabled === true) return 'local-first'
  return 'cloud'
}

/**
 * Raw local-first audio must remain on a workstation/private local volume.
 * Keep this an allowlist so a future remote backend cannot become eligible
 * without an explicit privacy review.
 */
export function isLocalFirstAudioStorageBackendCompatible(
  configured: string | undefined = process.env.AUDIO_STORAGE_BACKEND,
): boolean {
  let normalized = configured?.trim().toLowerCase()
  return normalized == null || normalized === '' || normalized === 'filesystem'
}

export function isPrivacyMode(value: unknown): value is PrivacyMode {
  return typeof value === 'string' && privacyModes.includes(value as PrivacyMode)
}

/** Missing legacy payload fields continue through the existing cloud path. */
export function normalizePrivacyMode(value: unknown): PrivacyMode {
  return isPrivacyMode(value) ? value : 'cloud'
}
