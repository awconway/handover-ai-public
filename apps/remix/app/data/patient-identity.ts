export type PatientIdentityReference = {
  key?: string | null
  displayName?: string | null
  location?: string | null
}

export function normalizePatientKey(value: string) {
  return value.trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function patientIdentityKey(reference: PatientIdentityReference) {
  let key = normalizePatientKey(reference.key ?? '')
  return key && !isPlaceholderPatientKey(key) ? key : derivedPatientIdentityKey(reference)
}

export function derivedPatientIdentityKey(reference: Omit<PatientIdentityReference, 'key'>) {
  let displayName = meaningfulPatientIdentity(reference.displayName)
  let location = meaningfulPatientIdentity(reference.location)
  return [displayName, location].filter(Boolean).join('-') || null
}

export function meaningfulPatientIdentity(value: string | null | undefined) {
  let identity = normalizePatientKey(value ?? '')
  return identity && !isPlaceholderPatientKey(identity) ? identity : ''
}

export function resolvePatientIdentityReferences<T extends PatientIdentityReference>(
  references: readonly T[],
  workspaceKey: string,
  identityAlias?: string | null,
) {
  let targetKey = normalizePatientKey(workspaceKey)
  if (!targetKey) return []
  let aliasKey = normalizePatientKey(identityAlias ?? '')
  let exact = references.filter((reference) => normalizePatientKey(reference.key ?? '') === targetKey)
  let fallbackIdentities = new Set([targetKey, aliasKey].filter(Boolean))
  let fallback = references.filter((reference) => {
    if (!isPlaceholderPatientKey(reference.key ?? '')) return false
    let identity = derivedPatientIdentityKey(reference)
    return Boolean(identity && fallbackIdentities.has(identity))
  })

  if (!isPlaceholderPatientKey(targetKey)) return uniqueReferences([...exact, ...fallback])
  if (aliasKey) {
    let matchingExact = exact.filter((reference) => derivedPatientIdentityKey(reference) === aliasKey)
    return uniqueReferences([...matchingExact, ...fallback])
  }

  if (exact.length <= 1) return exact
  let identities = exact.map(derivedPatientIdentityKey)
  let exactIdentities = new Set(identities.filter(Boolean))
  return identities.every(Boolean) && exactIdentities.size === 1 ? uniqueReferences(exact) : []
}

export function safePlaceholderPatientAliasKeys(
  references: readonly PatientIdentityReference[],
  workspaceKey: string,
  identityAlias?: string | null,
) {
  let targetIdentities = new Set([
    normalizePatientKey(workspaceKey),
    normalizePatientKey(identityAlias ?? ''),
  ].filter(Boolean))
  let identitiesByAlias = new Map<string, Set<string>>()
  for (let reference of references) {
    if (!isPlaceholderPatientKey(reference.key ?? '')) continue
    let alias = normalizePatientKey(reference.key ?? '')
    if (!alias) continue
    let identity = derivedPatientIdentityKey(reference) ?? ''
    let identities = identitiesByAlias.get(alias) ?? new Set<string>()
    identities.add(identity)
    identitiesByAlias.set(alias, identities)
  }
  return new Set([...identitiesByAlias].flatMap(([alias, identities]) => {
    if (identities.size !== 1) return []
    let [identity] = identities
    return identity && targetIdentities.has(identity) ? [alias] : []
  }))
}

function uniqueReferences<T>(references: readonly T[]) {
  return [...new Set(references)]
}

export function isPlaceholderPatientKey(value: string) {
  let key = normalizePatientKey(value)
  return key === ''
    || key === 'patient'
    || /^patient-\d+$/.test(key)
    || key === 'person'
    || /^person-\d+$/.test(key)
    || key === 'speaker'
    || /^speaker-\d+$/.test(key)
    || key === 'unknown'
    || key === 'unknown-patient'
    || /^unknown-patient-\d+$/.test(key)
    || key === 'unnamed'
    || key === 'unnamed-patient'
    || key === 'unidentified-patient'
    || key === 'displayname'
    || key === 'display-name'
    || key === 'null'
    || key === 'none'
    || key === 'not-provided'
    || key === 'not-available'
    || key === 'not-stated'
    || key === 'not-supplied'
    || key === 'unavailable'
    || key === 'missing'
    || key === 'tbd'
    || key === 'n-a'
    || key === 'na'
}
