/** Resolve either a native File or a request-scoped staged-file token. */
export function fileUpload(
  form: FormData,
  temporaryFiles: ReadonlyMap<string, File>,
  name: string,
): File | null {
  let value = form.get(name)
  if (value instanceof File) return value.size > 0 ? value : null
  if (typeof value !== 'string' || !value) return null
  let staged = temporaryFiles.get(value)
  return staged && staged.size > 0 ? staged : null
}
