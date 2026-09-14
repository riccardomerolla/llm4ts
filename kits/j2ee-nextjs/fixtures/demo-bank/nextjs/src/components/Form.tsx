'use client';

import { useCallback, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

/** Validation map: field name -> message. Empty map means valid. */
export type ValidationErrors<T> = Partial<
  Record<Extract<keyof T, string>, string>
>;

export interface FormRenderProps<T extends object> {
  readonly values: T;
  readonly errors: ValidationErrors<T>;
  readonly setValue: <K extends keyof T>(key: K, value: T[K]) => void;
  readonly submitting: boolean;
}

export interface FormProps<T extends object> {
  readonly initialValues: T;
  /** Pure, synchronous. Returns a map of messages; empty map = submit. */
  readonly validate?: (values: T) => ValidationErrors<T>;
  readonly onSubmit: (values: T) => void | Promise<void>;
  readonly children: (form: FormRenderProps<T>) => ReactNode;
}

/**
 * House form. Owns values, validation, and submit; pages provide fields via
 * the render prop and never call preventDefault or track error state
 * themselves.
 */
export function Form<T extends object>({
  initialValues,
  validate,
  onSubmit,
  children,
}: FormProps<T>) {
  const [values, setValues] = useState<T>(initialValues);
  const [errors, setErrors] = useState<ValidationErrors<T>>({});
  const [submitting, setSubmitting] = useState(false);

  const setValue = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((prev) => {
      const next = { ...prev };
      next[key] = value;
      return next;
    });
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validate === undefined ? {} : validate(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    const result = onSubmit(values);
    if (result instanceof Promise) {
      setSubmitting(true);
      void result.finally(() => {
        setSubmitting(false);
      });
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      {children({ values, errors, setValue, submitting })}
    </form>
  );
}
