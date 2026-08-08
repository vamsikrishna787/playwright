import type { ScriptStep } from '../types';

interface Props {
  steps: ScriptStep[];
  loading?: boolean;
}

/** Plain words for each kind of action, so the badge reads as a verb, not a term. */
const LABELS: Record<string, string> = {
  navigate: 'Go to',
  fill: 'Type',
  click: 'Click',
  select: 'Choose',
  check: 'Tick',
  press: 'Key',
  assert: 'Check',
  accessibility: 'Accessibility',
  other: 'Step',
};

/**
 * The non-technical view of a generated test: what it does, in order, in
 * sentences. Grouped by the test each step belongs to, because a file always
 * holds at least the functional test and the accessibility scan.
 */
export default function StepsView({ steps, loading }: Props) {
  if (loading) return <p className="muted">Reading the script…</p>;

  if (steps.length === 0) {
    return (
      <div className="card empty">
        No recognisable steps in this script yet. The Script tab shows the file itself.
      </div>
    );
  }

  const groups: Array<{ test: string; steps: ScriptStep[] }> = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (last && last.test === step.test) last.steps.push(step);
    else groups.push({ test: step.test, steps: [step] });
  }

  return (
    <div className="steps-view">
      {groups.map((group, index) => (
        <div key={`${group.test}-${index}`} className="step-group">
          <h3 className="step-group-title">{group.test || 'Test'}</h3>
          <ol className="plain-steps">
            {group.steps.map((step) => (
              <li key={step.index}>
                <span className={`action-kind ${step.action}`}>
                  {LABELS[step.action] ?? step.action}
                </span>
                <span className="step-text">{step.text}</span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
