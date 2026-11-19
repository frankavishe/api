import { HttpException } from '@nestjs/common';

/** Error codes from contracts/openapi.yaml#/components/schemas/Error */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'INVALID_PHONE'
  | 'INVALID_CODE'
  | 'CODE_EXPIRED'
  | 'TOO_MANY_ATTEMPTS'
  | 'ACCOUNT_NOT_FOUND'
  | 'USER_NOT_FOUND'
  | 'DEVICE_NOT_FOUND'
  | 'SESSION_REVOKED'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'CONVERSATION_NOT_FOUND'
  | 'NOT_A_MEMBER'
  | 'FORBIDDEN'
  | 'DEVICE_MISMATCH'
  | 'KEYS_NOT_UPLOADED'
  | 'GROUP_TOO_LARGE'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL';

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** An HttpException whose response body is already in the contract's Error shape. */
export class AppError extends HttpException {
  constructor(status: number, code: ErrorCode, message: string, details?: Record<string, unknown>) {
    const body: ErrorBody = details ? { code, message, details } : { code, message };
    super(body, status);
  }

  static badRequest(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    return new AppError(400, code, message, details);
  }
  static unauthorized(code: ErrorCode = 'UNAUTHORIZED', message = 'Not signed in') {
    return new AppError(401, code, message);
  }
  static notFound(code: ErrorCode, message: string) {
    return new AppError(404, code, message);
  }
  static forbidden(code: ErrorCode, message: string) {
    return new AppError(403, code, message);
  }
  static conflict(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    return new AppError(409, code, message, details);
  }
  static rateLimited(retryAfter: number) {
    return new AppError(429, 'RATE_LIMITED', 'Too many requests, try again later', { retryAfter });
  }
}
