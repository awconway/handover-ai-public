export const frameMutationRequestHeader = 'x-remix-frame-mutation'
export const frameMutationRequestValue = 'reload'
export const frameMutationLocationHeader = 'x-remix-frame-mutation-location'
export const frameMutationResultHeader = 'x-remix-frame-mutation-result'
export const frameMutationSuccessValue = 'success'

export function isFrameMutationRequest(request: Request): boolean {
  return request.headers.get(frameMutationRequestHeader) === frameMutationRequestValue
}

export function markFrameMutationSuccess(request: Request, response: Response): Response {
  if (isFrameMutationRequest(request)) {
    response.headers.set(frameMutationResultHeader, frameMutationSuccessValue)
  }
  return response
}
