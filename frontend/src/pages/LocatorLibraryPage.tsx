import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { DomainLibrary, LibraryDocument, LocatorEntry } from '../types';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const rowId = (pageUrl: string, key: string) => `${pageUrl}::${key}`;

/** "8 Aug, 14:32" — short enough for a table cell, exact enough to be useful. */
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

const full = (iso: string) => new Date(iso).toLocaleString();

/**
 * The moment an entry crossed from observed to verified.
 *
 * Entries verified before that timestamp was recorded have only lastVerifiedAt
 * to go on — the most recent confirmation, which is the closest honest answer
 * available for them.
 */
const verifiedFrom = (entry: LocatorEntry) => entry.verifiedSince ?? entry.lastVerifiedAt;

interface Draft {
  name: string;
  locator: string;
  /** One alternate per line — the plainest editor for a short list. */
  alternates: string;
}

const draftOf = (entry: LocatorEntry): Draft => ({
  name: entry.name,
  locator: entry.locator,
  alternates: entry.alternates.join('\n'),
});

export default function LocatorLibraryPage() {
  const { domainId } = useParams<{ domainId: string }>();
  const [library, setLibrary] = useState<DomainLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ name: '', locator: '', alternates: '' });

  useEffect(() => {
    if (!domainId) return;
    api.getLibrary(domainId).then(setLibrary).catch((err) => setError(message(err)));
  }, [domainId]);

  const guard = async (id: string, action: () => Promise<LibraryDocument>) => {
    setBusy(id);
    setError(null);
    try {
      const next = await action();
      // The write endpoints answer with the library alone; keep the domain we
      // already have so the header does not blink out.
      setLibrary((current) => (current ? { ...current, ...next } : current));
      return true;
    } catch (err) {
      setError(message(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const startEdit = (pageUrl: string, entry: LocatorEntry) => {
    setError(null);
    setEditing(rowId(pageUrl, entry.key));
    setDraft(draftOf(entry));
  };

  const saveEdit = async (pageUrl: string, entry: LocatorEntry) => {
    if (!domainId) return;
    const saved = await guard(rowId(pageUrl, entry.key), () =>
      api.updateLocator(domainId, {
        pageUrl,
        key: entry.key,
        name: draft.name.trim(),
        locator: draft.locator,
        alternates: draft.alternates
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      }),
    );
    // A rejected expression keeps the editor open with the text still in it,
    // so the message and the thing it is about stay on screen together.
    if (saved) setEditing(null);
  };

  const dropPage = (pageUrl: string) => {
    if (!domainId || !window.confirm(`Forget every locator recorded on ${pageUrl}?`)) return;
    guard(pageUrl, () => api.deleteLocator(domainId, { pageUrl }));
  };

  const dropEntry = (pageUrl: string, key: string) => {
    if (!domainId) return;
    guard(rowId(pageUrl, key), () => api.deleteLocator(domainId, { pageUrl, key }));
  };

  const promote = (pageUrl: string, key: string, locator: string) => {
    if (!domainId) return;
    guard(rowId(pageUrl, key), () => api.promoteLocator(domainId, { pageUrl, key, locator }));
  };

  if (error && !library) return <div className="error-box">{error}</div>;
  if (!library) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="spread">
        <div>
          <h1>{library.domain.name} · locator library</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            {library.locatorCount} elements across {library.pageCount} page
            {library.pageCount === 1 ? '' : 's'} · {library.verifiedCount} proven by a passing run.
            Every generation on this site is grounded in these, so an edit here changes every test
            written from now on.
          </p>
        </div>
        <div className="row">
          <Link to={`/domains/${library.domain.id}/record`}>
            <button className="primary">Record more</button>
          </Link>
          <Link to="/scripts">
            <button>Back to scripts</button>
          </Link>
        </div>
      </div>

      {error && (
        <div className="error-box" style={{ marginTop: 16 }}>
          {error}
        </div>
      )}

      {library.pages.length === 0 && (
        <div className="card empty" style={{ marginTop: 24 }}>
          Nothing recorded yet for this site.
        </div>
      )}

      {library.pages.map((page) => (
        <section key={page.url} className="domain">
          <div className="domain-head">
            <div>
              <h2 className="domain-name mono" style={{ wordBreak: 'break-all' }}>
                {page.url}
              </h2>
              <span className="muted domain-meta">
                {page.title || 'Untitled'} · {page.locators.length} locators · updated{' '}
                {new Date(page.updatedAt).toLocaleString()}
              </span>
            </div>
            <button
              className="danger"
              onClick={() => dropPage(page.url)}
              disabled={busy === page.url}
            >
              Forget page
            </button>
          </div>

          <table>
            <thead>
              <tr>
                <th style={{ width: 190 }}>Element</th>
                <th>Locator</th>
                <th style={{ width: 100 }}>Status</th>
                <th style={{ width: 150 }} />
              </tr>
            </thead>
            <tbody>
              {page.locators.map((entry) => {
                const id = rowId(page.url, entry.key);
                const isEditing = editing === id;
                const working = busy === id;

                if (isEditing) {
                  return (
                    <tr key={entry.key}>
                      <td colSpan={4}>
                        <div className="locator-edit">
                          <div className="field">
                            <label htmlFor={`${id}-name`}>
                              Element name{' '}
                              <span className="hint">— what this control is called</span>
                            </label>
                            <input
                              id={`${id}-name`}
                              type="text"
                              value={draft.name}
                              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                            />
                          </div>

                          <div className="field">
                            <label htmlFor={`${id}-locator`}>
                              Locator <span className="hint">— the expression tests will use</span>
                            </label>
                            <input
                              id={`${id}-locator`}
                              type="text"
                              className="mono"
                              value={draft.locator}
                              onChange={(e) => setDraft({ ...draft, locator: e.target.value })}
                              placeholder="getByRole('button', { name: 'Login' })"
                            />
                            <p className="hint" style={{ marginTop: 6 }}>
                              A leading <code>page.</code> is fine — it is stripped on save.
                              Changing this clears the verified mark until a run proves the new
                              expression.
                            </p>
                          </div>

                          <div className="field">
                            <label htmlFor={`${id}-alternates`}>
                              Alternates <span className="hint">— one per line, optional</span>
                            </label>
                            <textarea
                              id={`${id}-alternates`}
                              className="mono"
                              style={{ minHeight: 64 }}
                              value={draft.alternates}
                              onChange={(e) => setDraft({ ...draft, alternates: e.target.value })}
                            />
                          </div>

                          <div className="row">
                            <button
                              className="primary"
                              onClick={() => saveEdit(page.url, entry)}
                              disabled={working || !draft.locator.trim()}
                            >
                              {working ? 'Saving…' : 'Save'}
                            </button>
                            <button onClick={() => setEditing(null)} disabled={working}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr key={entry.key}>
                    <td>
                      <div>{entry.name || entry.placeholder || '(unnamed)'}</div>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {entry.role || entry.tag}
                      </div>
                    </td>
                    <td>
                      <code className="mono">page.{entry.locator}</code>
                      {entry.alternates.map((alternate) => (
                        <div key={alternate} className="alternate">
                          <code className="mono muted">page.{alternate}</code>
                          <button
                            className="link-button"
                            onClick={() => promote(page.url, entry.key, alternate)}
                            disabled={working}
                          >
                            use this one
                          </button>
                        </div>
                      ))}
                    </td>
                    <td>
                      {entry.verified ? (
                        <>
                          <span className="badge verified">verified</span>
                          {verifiedFrom(entry) && (
                            <div
                              className="muted status-when"
                              title={`Became verified: ${
                                entry.verifiedSince
                                  ? full(entry.verifiedSince)
                                  : 'before this was recorded'
                              }\nLast confirmed: ${
                                entry.lastVerifiedAt ? full(entry.lastVerifiedAt) : '—'
                              }`}
                            >
                              since {when(verifiedFrom(entry)!)}
                              {/* A later confirmation is worth showing: it says
                                  the locator still worked recently, not just once. */}
                              {entry.lastVerifiedAt &&
                                entry.lastVerifiedAt !== verifiedFrom(entry) && (
                                  <>
                                    <br />
                                    last ok {when(entry.lastVerifiedAt)}
                                  </>
                                )}
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <span className="muted">observed</span>
                          <div
                            className="muted status-when"
                            title={`First seen: ${full(entry.firstSeenAt)}\nLast seen: ${full(
                              entry.lastSeenAt,
                            )}${
                              entry.lastVerifiedAt
                                ? `\nA previous expression for this element last passed: ${full(
                                    entry.lastVerifiedAt,
                                  )}`
                                : ''
                            }`}
                          >
                            seen {when(entry.lastSeenAt)}
                            {entry.lastVerifiedAt && (
                              <>
                                <br />
                                <span title="An earlier expression for this element was verified; this one has not run yet.">
                                  was verified
                                </span>
                              </>
                            )}
                          </div>
                        </>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button onClick={() => startEdit(page.url, entry)} disabled={working}>
                          Edit
                        </button>
                        <button
                          className="danger"
                          onClick={() => dropEntry(page.url, entry.key)}
                          disabled={working}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
