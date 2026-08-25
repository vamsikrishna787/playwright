import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { formatWhen } from '../components/StatusBadge';
import type { SuiteSummary } from '../types';

/** The home page: every suite, and how its tests last did. */
export default function SuitesPage() {
  const [suites, setSuites] = useState<SuiteSummary[] | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', baseUrl: '', description: '' });
  const [saving, setSaving] = useState(false);

  const load = () =>
    api
      .listSuites()
      .then(setSuites)
      .catch((failure: Error) => setError(failure.message));

  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    if (!draft.name.trim()) return;
    setSaving(true);
    setError('');
    try {
      await api.createSuite(draft);
      setDraft({ name: '', baseUrl: '', description: '' });
      setAdding(false);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Test suites</h1>
          <p className="muted" style={{ margin: 0 }}>
            A suite groups the tests for one site or one journey.
          </p>
        </div>
        <button className="primary" onClick={() => setAdding((on) => !on)}>
          {adding ? 'Cancel' : 'New suite'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {adding && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row">
            <div>
              <label>Name</label>
              <input
                autoFocus
                value={draft.name}
                placeholder="SauceDemo checkout"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                onKeyDown={(event) => event.key === 'Enter' && create()}
              />
            </div>
            <div>
              <label>Base URL</label>
              <input
                value={draft.baseUrl}
                placeholder="https://www.saucedemo.com/"
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                onKeyDown={(event) => event.key === 'Enter' && create()}
              />
            </div>
            <div className="shrink">
              <button className="primary" onClick={create} disabled={!draft.name.trim() || saving}>
                {saving ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>
            The base URL prefills every test added under this suite.
          </p>
        </div>
      )}

      {suites === null ? (
        <div className="empty">Loading…</div>
      ) : suites.length === 0 ? (
        <div className="empty">
          No suites yet. Create one to start adding tests.
        </div>
      ) : (
        <div className="grid">
          {suites.map((suite) => (
            <Link className="card suite-card" to={`/suites/${suite.id}`} key={suite.id}>
              <h3>{suite.name}</h3>
              <div className="small muted mono">{suite.baseUrl || 'no base URL'}</div>
              {suite.description && (
                <p className="small muted" style={{ marginBottom: 0 }}>
                  {suite.description}
                </p>
              )}

              <div className="stat-row">
                <span>
                  <b>{suite.testCount}</b> test{suite.testCount === 1 ? '' : 's'}
                </span>
                <span>
                  <b>{suite.scriptCount}</b> scripted
                </span>
                {suite.passed > 0 && (
                  <span style={{ color: 'var(--pass)' }}>
                    <b style={{ color: 'inherit' }}>{suite.passed}</b> passing
                  </span>
                )}
                {suite.failed > 0 && (
                  <span style={{ color: 'var(--fail)' }}>
                    <b style={{ color: 'inherit' }}>{suite.failed}</b> failing
                  </span>
                )}
              </div>

              {suite.lastRunAt && (
                <div className="small muted" style={{ marginTop: 6 }}>
                  last run {formatWhen(suite.lastRunAt)}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
