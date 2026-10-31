import { ZodError } from 'zod';
import { fieldErrors, OrderRuleError, type ApiErrorBody } from '@pte/shared';
import type { ErrorRequestHandler } from 'express';

/** An error that is safe to show to the user, with the HTTP status to send. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string> | undefined;

  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export function notFound(what: string): AppError {
  return new AppError(404, 'NOT_FOUND', `${what} not found`);
}

export function unauthorized(): AppError {
  return new AppError(401, 'UNAUTHORIZED', 'Please log in to continue');
}

function body(code: string, message: string, fields?: Record<string, string>): ApiErrorBody {
  return { error: fields ? { code, message, fields } : { code, message } };
}

/** Express body-parser marks malformed JSON with this type. */
function isJsonParseError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    (error as { type: unknown }).type === 'entity.parse.failed'
  );
}

/**
 * The single place errors become HTTP responses. Known errors get their own
 * message; anything unexpected is logged and the user sees a generic message —
 * never a stack trace or SQL error.
 */
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AppError) {
    res.status(error.status).json(body(error.code, error.message, error.fields));
    return;
  }
  if (error instanceof OrderRuleError) {
    res.status(400).json(body(error.code, error.message));
    return;
  }
  if (error instanceof ZodError) {
    const fields = fieldErrors(error);
    const first = Object.values(fields)[0] ?? 'Invalid request';
    res.status(400).json(body('VALIDATION_ERROR', first, fields));
    return;
  }
  if (isJsonParseError(error)) {
    res.status(400).json(body('INVALID_JSON', 'Request body must be valid JSON'));
    return;
  }
  console.error('[http] unexpected error:', error);
  res
    .status(500)
    .json(body('INTERNAL_ERROR', 'Something went wrong on our side. Please try again.'));
};
