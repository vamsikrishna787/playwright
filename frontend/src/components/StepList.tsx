import type { RunStep } from '../types';

export default function StepList({ steps }: { steps: RunStep[] }) {
  if (steps.length === 0) return <p className="muted">No steps recorded for this run.</p>;

  return (
    <ul className="steps">
      {steps.map((step, index) => (
        <li key={index} className={step.error ? 'failed' : ''}>
          <div>
            <div>{step.title}</div>
            {step.error && <div className="step-error">{step.error}</div>}
          </div>
          <span className="muted mono">{step.durationMs}ms</span>
        </li>
      ))}
    </ul>
  );
}
