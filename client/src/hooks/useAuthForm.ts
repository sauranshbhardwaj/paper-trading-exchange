import { useState, type FormEvent } from 'react';
import type { z } from 'zod';
import { errorsFromUnknown, errorsFromZod, NO_ERRORS, type FormErrors } from '../lib/forms.ts';

/**
 * Shared form plumbing for login and register: controlled values, the same
 * Zod schema the server uses for instant validation, and server errors mapped
 * back onto fields.
 */
export function useAuthForm<Values extends Record<string, string>>(
  schema: z.ZodType,
  initial: Values,
  action: (values: Values) => Promise<void>,
) {
  const [values, setValues] = useState<Values>(initial);
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [submitting, setSubmitting] = useState(false);

  function setField(name: keyof Values, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => {
      const fields = { ...current.fields };
      delete fields[name as string];
      return { fields, message: null };
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      setErrors(errorsFromZod(parsed.error));
      return;
    }
    setSubmitting(true);
    try {
      await action(values);
    } catch (error) {
      setErrors(errorsFromUnknown(error));
      setSubmitting(false);
    }
  }

  return { values, errors, submitting, setField, submit };
}
