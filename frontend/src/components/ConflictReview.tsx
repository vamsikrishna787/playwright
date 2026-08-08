import type { ConflictChoice, LocatorConflict } from '../types';

interface Props {
  conflicts: LocatorConflict[];
  choices: Record<string, ConflictChoice>;
  onChange: (id: string, choice: ConflictChoice) => void;
}

/** Stable per-conflict identity — a page can hold two elements with the same key. */
export const conflictId = (conflict: LocatorConflict) => `${conflict.pageUrl}::${conflict.key}`;

const OPTIONS: Array<{ value: ConflictChoice; label: string; hint: string }> = [
  {
    value: 'original',
    label: 'Keep the original',
    hint: 'The saved locator stays. Use this when the change looks like a one-off render.',
  },
  {
    value: 'new',
    label: 'Replace with the new one',
    hint: 'The page really changed and the old expression is gone.',
  },
  {
    value: 'both',
    label: 'Keep both',
    hint: 'These are two different elements that happen to share a name.',
  },
];

export default function ConflictReview({ conflicts, choices, onChange }: Props) {
  const byPage = conflicts.reduce<Record<string, LocatorConflict[]>>((acc, conflict) => {
    acc[conflict.pageUrl] = [...(acc[conflict.pageUrl] ?? []), conflict];
    return acc;
  }, {});

  return (
    <>
      {Object.entries(byPage).map(([pageUrl, list]) => (
        <div key={pageUrl} className="card conflict-page">
          <div className="mono muted conflict-page-url">{pageUrl}</div>

          {list.map((conflict) => {
            const id = conflictId(conflict);
            const choice = choices[id] ?? 'new';
            return (
              <div key={id} className="conflict">
                <div className="conflict-title">
                  {conflict.name || conflict.key}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    {' '}
                    · {conflict.role || 'element'}
                  </span>
                  {conflict.existingVerified && (
                    <span className="badge verified" style={{ marginLeft: 8 }}>
                      saved one is verified
                    </span>
                  )}
                </div>

                <div className="conflict-diff">
                  <div>
                    <span className="conflict-tag">Saved</span>
                    <code className="mono">page.{conflict.existingLocator}</code>
                  </div>
                  <div>
                    <span className="conflict-tag new">Just recorded</span>
                    <code className="mono">page.{conflict.newLocator}</code>
                  </div>
                </div>

                <div className="conflict-choices">
                  {OPTIONS.map((option) => (
                    <label key={option.value} className="choice" title={option.hint}>
                      <input
                        type="radio"
                        name={id}
                        checked={choice === option.value}
                        onChange={() => onChange(id, option.value)}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
