export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  })
}

export function requireMethod(request: Request, allowed: string[]): void {
  if (!allowed.includes(request.method)) {
    throw new HttpError(405, `${request.method} is not supported for this route.`)
  }
}

export async function readJsonBody<TBody>(request: Request): Promise<Partial<TBody>> {
  const text = await request.text()
  if (!text.trim()) {
    return {}
  }
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new HttpError(400, "JSON body must be an object.")
    }
    return value as Partial<TBody>
  } catch (error) {
    if (error instanceof HttpError) {
      throw error
    }
    throw new HttpError(400, "Request body must be valid JSON.")
  }
}

export function readStringField(value: unknown, field: string, options: { required: true; maxLength?: number }): string
export function readStringField(value: unknown, field: string, options?: { required?: false; maxLength?: number }): string | undefined
export function readStringField(
  value: unknown,
  field: string,
  options: { required?: boolean; maxLength?: number } = {},
): string | undefined {
  if (value === undefined || value === null) {
    if (options.required) {
      throw new HttpError(400, `${field} is required.`)
    }
    return undefined
  }
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be a string.`)
  }
  const trimmed = value.trim()
  if (!trimmed && options.required) {
    throw new HttpError(400, `${field} is required.`)
  }
  if (options.maxLength && trimmed.length > options.maxLength) {
    throw new HttpError(400, `${field} must be ${options.maxLength} characters or fewer.`)
  }
  return trimmed || undefined
}

export function readBooleanField(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, `${field} must be a boolean.`)
  }
  return value
}

export function readRecordField(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${field} must be an object.`)
  }
  return value as Record<string, unknown>
}

export function handleRouteError(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse({ error: error.message }, { status: error.status })
  }
  return jsonResponse(
    { error: error instanceof Error ? error.message : "Request failed." },
    { status: 500 },
  )
}
