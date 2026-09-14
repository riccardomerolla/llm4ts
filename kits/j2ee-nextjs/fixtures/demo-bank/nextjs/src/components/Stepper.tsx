'use client';

export interface StepperProps {
  readonly steps: ReadonlyArray<string>;
  /** Zero-based index of the active step. */
  readonly activeIndex: number;
}

/** House progress indicator for multi-step journeys (wizards, onboarding). */
export function Stepper({ steps, activeIndex }: StepperProps) {
  return (
    <ol className="db-stepper">
      {steps.map((step, index) => (
        <li
          key={step}
          className={
            index === activeIndex
              ? 'db-stepper-step db-stepper-step--active'
              : 'db-stepper-step'
          }
          aria-current={index === activeIndex ? 'step' : undefined}
        >
          <span className="db-stepper-index">{index + 1}</span>
          {step}
        </li>
      ))}
    </ol>
  );
}
