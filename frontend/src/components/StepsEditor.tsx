import { useEffect, useState } from 'react';
import type { StepDraft } from '../api/client';
import type { DataField, TestStep } from '../types';

/**
 * The authored steps: what to do, what should then be true, and which data
 * fields the step uses.
 *
 * Attaching fields to a step is what makes the generated script read
 * `data.username` instead of inlining a literal, so the chips are part of the
 * instruction to the agent rather than decoration.
 */
export default function StepsEditor({
  steps,
  dataFields,
  saving,
  onSave,
}: {
  steps: TestStep[];
  dataFields: DataField[];
  saving: boolean;
  onSave: (steps: StepDraft[]) => void;
}) {
  const [rows, setRows] = useState<StepDraft[]>(steps);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setRows(steps);
    setDirty(false);
  }, [steps]);

  const edit = (index: number, patch: Partial<StepDraft>) => {
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
    setDirty(true);
  };

  const add = () => {
    setRows((current) => [...current, { id: '', action: '', expected: '', dataFieldIds: [] }]);
    setDirty(true);
  };

  const remove = (index: number) => {
    setRows((current) => current.filter((_, at) => at !== index));
    setDirty(true);
  };

  /** Reordering renumbers on save, which is what the [Sn] tags follow. */
  const move = (index: number, by: number) => {
    setRows((current) => {
      const target = index + by;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [held] = next.splice(index, 1);
      next.splice(target, 0, held!);
      return next;
    });
    setDirty(true);
  };

  const toggleField = (index: number, fieldId: string) => {
    setRows((current) =>
      current.map((row, at) =>
        at === index
          ? {
              ...row,
              dataFieldIds: row.dataFieldIds.includes(fieldId)
                ? row.dataFieldIds.filter((id) => id !== fieldId)
                : [...row.dataFieldIds, fieldId],
            }
          : row,
      ),
    );
    setDirty(true);
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Steps</h2>
          <p className="muted small" style={{ margin: 0 }}>
            These are the instructions the agent generates from, and the list a run reports progress
            against.
          </p>
        </div>
        <div className="actions">
          <button onClick={add}>Add step</button>
          <button
            className="primary"
            disabled={!dirty || saving}
            onClick={() => onSave(rows.filter((row) => row.action.trim()))}
          >
            {saving ? 'Saving…' : 'Save steps'}
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          No steps yet. Add one describing the first thing a person would do on the page.
        </div>
      ) : (
        <div className="steps">
          {rows.map((row, index) => (
            <div className="step" key={row.id || `new-${index}`}>
              <div className="num">{index + 1}</div>
              <div className="body">
                <div className="field" style={{ marginBottom: 8 }}>
                  <input
                    value={row.action}
                    placeholder="What to do — e.g. Click the Login button"
                    onChange={(event) => edit(index, { action: event.target.value })}
                  />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <input
                    value={row.expected}
                    placeholder="What's expected — e.g. The inventory page is shown"
                    onChange={(event) => edit(index, { expected: event.target.value })}
                  />
                </div>

                {dataFields.length > 0 && (
                  <div className="chips">
                    <span className="small muted" style={{ marginRight: 2 }}>
                      uses:
                    </span>
                    {dataFields.map((field) => (
                      <button
                        key={field.id}
                        type="button"
                        className={`chip${row.dataFieldIds.includes(field.id) ? '' : ' off'}`}
                        title={`${field.category} · ${field.secret ? '••••' : field.value}`}
                        onClick={() => toggleField(index, field.id)}
                      >
                        data.{field.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <button className="ghost" onClick={() => move(index, -1)} disabled={index === 0}>
                  ↑
                </button>
                <button
                  className="ghost"
                  onClick={() => move(index, 1)}
                  disabled={index === rows.length - 1}
                >
                  ↓
                </button>
                <button className="ghost danger" onClick={() => remove(index)}>
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
