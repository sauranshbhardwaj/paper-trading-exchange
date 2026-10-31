import { fieldErrors } from '@pte/shared';
import type { z } from 'zod';
import { ApiError } from './api.ts';

export interface FormErrors {
  fields: Record<string, string>;
  message: string | null;
}

export const NO_ERRORS: FormErrors = { fields: {}, message: null };

export function errorsFromZod(error: z.ZodError): FormErrors {
  return { fields: fieldErrors(error), message: null };
}

/** Any thrown value -> something we can show next to the form. Never a raw error. */
export function errorsFromUnknown(error: unknown): FormErrors {
  if (error instanceof ApiError) {
    const hasFields = Object.keys(error.fields).length > 0;
    return { fields: error.fields, message: hasFields ? null : error.message };
  }
  return { fields: {}, message: 'Something went wrong. Please try again.' };
}
