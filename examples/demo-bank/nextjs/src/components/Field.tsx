'use client';

import type { ReactNode } from 'react';

export interface FieldProps {
  /** id of the control rendered inside the field (label htmlFor pairs with it). */
  readonly id: string;
  readonly label: string;
  /** Validation message; when set the field renders in its invalid state. */
  readonly error?: string;
  /** Exactly one form control (input/select/textarea) with the matching id. */
  readonly children: ReactNode;
}

/**
 * Field wraps label + control + error. Pages never hand-roll label/error
 * markup; every form control lives inside a Field.
 */
export function Field({ id, label, error, children }: FieldProps) {
  const invalid = typeof error === 'string' && error.length > 0;
  return (
    <div className={invalid ? 'db-field db-field--invalid' : 'db-field'}>
      <label className="db-field-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {invalid ? (
        <p className="db-field-error" role="alert" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
