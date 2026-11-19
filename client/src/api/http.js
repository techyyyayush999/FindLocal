export class ApiError extends Error {
  constructor(message, { status = 0, errors = [], body = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.errors = Array.isArray(errors) ? errors : []
    this.body = body
  }
}

export function isApiError(error) {
  return error instanceof ApiError
}

export function fieldErrorMap(error) {
  if (!isApiError(error)) return {}
  const map = {}
  for (const item of error.errors) {
    if (item.field && item.field !== '') {
      map[item.field] = item.message
    }
  }
  return map
}

export function formatError(error) {
  if (!error) return 'Something went wrong.'
  if (isApiError(error)) return error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

function apiBase() {
  const configured = import.meta.env.VITE_API_BASE_URL
  if (typeof configured === 'string' && configured.trim()) {
    return configured.replace(/\/$/, '')
  }
  return ''
}

export async function apiFetch(path, options = {}) {
  const { headers, body, ...rest } = options
  const url = `${apiBase()}${path}`

  let response
  try {
    response = await fetch(url, {
      ...rest,
      credentials: 'include',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body,
    })
  } catch {
    throw new ApiError(
      'Unable to reach FindLocal. Check your connection and that the API is running.',
      { status: 0 }
    )
  }

  const contentType = response.headers.get('content-type') || ''
  let parsed = null
  if (contentType.includes('application/json')) {
    try {
      parsed = await response.json()
    } catch {
      parsed = null
    }
  }

  if (!response.ok) {
    throw new ApiError(parsed?.message || `Request failed (${response.status}).`, {
      status: response.status,
      errors: parsed?.errors,
      body: parsed,
    })
  }

  return parsed
}
