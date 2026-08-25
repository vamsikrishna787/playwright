import { useEffect, useState } from 'react';
import type { FieldDraft } from '../api/client';
import type { DataField } from '../types';

/**
 * The test's data: a name, a value, and the category it belongs to.
 *
 * The name is not cosmetic - it becomes the key on the `data` object in the
 * generated script, and steps reference it as `data.<name>`. That is why the
 * name column is monospaced and why duplicates are rejected on save.
 */
export default function DataFieldsEditor({
  fields,
  saving,
  onSave,
}: {
  fields: DataField[];
  saving: boolean;
  onSave: (fields: FieldDraft[]) => void;
}) {
  const [rows, setRows] = useState<FieldDraft[]>(fields);
  const [dirty, setDirty] = useState(false);

  // Re-sync when the server hands back a saved list (ids assigned, names trimmed).
  useEffect(() => {
    setRows(fields);
    setDirty(false);
  }, [fields]);

  const edit = (index: number, patch: Partial<FieldDraft>) => {
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
    setDirty(true);
  };

  const add = () => {
    setRows((current) => [
      ...current,
      // Repeating the last category is the common case: fields arrive in groups.
      { category: current.at(-1)?.category || 'General', name: '', value: '', secret: false },
    ]);
    setDirty(true);
  };

  const remove = (index: number) => {
    setRows((current) => current.filter((_, at) => at !== index));
    setDirty(true);
  };

  const named = rows.filter((row) => row.name.trim());
  const duplicate = named.find(
    (row, at) =>
      named.findIndex((other) => other.name.trim().toLowerCase() === row.name.trim().toLowerCase()) !==
      at,
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Test data</h2>
          <p className="muted small" style={{ margin: 0 }}>
            Each field becomes a key on the <code className="mono">data</code> object in the
            generated script. Steps reference it by name, so changing a value here never means
            regenerating the script.
          </p>
        </div>
        <div className="actions">
          <button onClick={add}>Add field</button>
          <button
            className="primary"
            disabled={!dirty || saving || Boolean(duplicate)}
            onClick={() => onSave(rows.filter((row) => row.name.trim()))}
          >
            {saving ? 'Saving…' : 'Save data'}
          </button>
        </div>
      </div>

      {duplicate && (
        <div className="error-banner">
          Two fields are both named "{duplicate.name}". Names become object keys, so each must be
          unique.
        </div>
      )}

      {rows.length === 0 ? (
        <div className="empty">
          No data yet. Add a field for anything the test types in — a username, a search term, a
          postcode.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th style={{ width: '20%' }}>Category</th>
              <th style={{ width: '25%' }}>Field name</th>
              <th>Value</th>
              <th style={{ width: 70 }}>Secret</th>
              <th style={{ width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id ?? `new-${index}`}>
                <td>
                  <input
                    value={row.category}
                    placeholder="Login"
                    onChange={(event) => edit(index, { category: event.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="mono"
                    value={row.name}
                    placeholder="username"
                    onChange={(event) => edit(index, { name: event.target.value })}
                  />
                </td>
                <td>
                  <input
                    type={row.secret ? 'password' : 'text'}
                    value={row.value}
                    placeholder="standard_user"
                    onChange={(event) => edit(index, { value: event.target.value })}
                  />
                </td>
                <td style={{ textAlign: 'center', paddingTop: 12 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={row.secret}
                    // Masks the field in this UI only. The value is still written
                    // into the spec - these are test accounts, not credentials.
                    title="Mask this value on screen"
                    onChange={(event) => edit(index, { secret: event.target.checked })}
                  />
                </td>
                <td>
                  <button className="ghost danger" onClick={() => remove(index)} title="Remove">
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
