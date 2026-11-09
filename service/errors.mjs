// 统一错误类型：HTTP 层按 status/code 输出 { error, code }
export class ApiError extends Error {
  constructor(status, message, code = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message, code = 'BAD_REQUEST') {
  return new ApiError(400, message, code);
}

export function unauthorized() {
  return new ApiError(401, 'unauthorized', undefined);
}

export function notFound(message = 'not found', code = 'NOT_FOUND') {
  return new ApiError(404, message, code);
}

export function lockedError() {
  return new ApiError(409, 'locked', 'LOCKED');
}

export function conflictError(message, code = 'CONFLICT') {
  return new ApiError(409, message, code);
}

export function isApiError(err) {
  return !!err && err instanceof ApiError;
}
