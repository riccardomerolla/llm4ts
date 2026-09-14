'use client';

import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
}

/** House button. Default type is "button"; forms opt in with type="submit". */
export function Button({
  variant = 'primary',
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = ['db-button', `db-button--${variant}`, className]
    .filter((c) => typeof c === 'string' && c.length > 0)
    .join(' ');
  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}
