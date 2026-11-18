import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
  StandardSchemaValidationPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { AppError, type ErrorBody, type ErrorCode } from './errors.js';

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  404: 'USER_NOT_FOUND',
  413: 'FILE_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

function isErrorBody(x: unknown): x is ErrorBody {
  return typeof x === 'object' && x !== null && 'code' in x && 'message' in x;
}

/** Turns every error into the contract's `{ code, message, details? }` shape. */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw exception;
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (isErrorBody(body)) {
        if (status === 429 && typeof body.details?.retryAfter === 'number') {
          res.setHeader('Retry-After', String(body.details.retryAfter));
        }
        res.status(status).json(body);
        return;
      }
      const message =
        typeof body === 'object' && body !== null && 'message' in body
          ? String((body as { message: unknown }).message)
          : exception.message;
      res.status(status).json({
        code: STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED'),
        message,
      } satisfies ErrorBody);
      return;
    }

    this.logger.error(exception);
    res.status(500).json({ code: 'INTERNAL', message: 'Something went wrong' } satisfies ErrorBody);
  }
}

/** Global Zod (Standard Schema) validation producing VALIDATION_FAILED errors. */
export function createValidationPipe() {
  return new StandardSchemaValidationPipe({
    exceptionFactory: (issues) =>
      AppError.badRequest('VALIDATION_FAILED', 'Request is not valid', {
        errors: issues.map((issue) => ({
          path: (issue.path ?? [])
            .map((s) => (typeof s === 'object' ? String(s.key) : String(s)))
            .join('.'),
          message: issue.message,
        })),
      }),
  });
}
