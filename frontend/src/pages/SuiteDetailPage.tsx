import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { StatusBadge, formatWhen } from '../components/StatusBadge';
import type { SuiteDetail } from '../types';

/** One suite: the tests under it, and running the whole set. */
export default function SuiteDetailPage() {
  const { suiteId = '' } = useParams();
  const navigate = useNavigate();

  const [suite, setSuite] = useState<SuiteDetail | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  /** Polled while anything in the suite is mid-run. */
  const [watching, setWatching] = useState(false);

  const load = useCallback(
    () =>
      api
        .getSuite(suiteId)
        .then(setSuite)
        .catch((failure: Error) => setError(failure.message)),
    [suiteId],
  );

  useEffect(() => {
    load();
  }, [load]);

  // A suite run touches many tests at once, so the list polls rather than
  // opening an SSE stream per test. Individual progress lives on the test page.
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(async () => {
      const next = await api.getSuite(suiteId).catch(() => null);
      if (!next) return;
      setSuite(next);
      const active = next.tests.some(
        (test) => test.lastRun?.status === 'running' || test.lastRun?.status === 'queued',
      );
      if (!active) setWatching(false);
    }, 2000);
    return () => clearInterval(timer);
  }, [watching, suiteId]);

  const addTest = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const created = await api.createTest(suiteId, { name });
      navigate(`/tests/${created.id}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };

  const runAll = async () => {
    setBusy(true);
    setError('');
    try {
      await api.runSuite(suiteId);
      setWatching(true);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const removeSuite = async () => {
    if (!confirm(`Delete "${suite?.name}" and all its tests, scripts and runs?`)) return;
    await api.deleteSuite(suiteId);
    navigate('/');
  };

  if (!suite) {
    return error ? <div className="error-banner">{error}</div> : <div className="empty">Loading…</div>;
  }

  const scripted = suite.tests.filter((test) => test.scriptPath).length;

  return (
    <div>
      <div className="crumbs">
        <Link to="/">Suites</Link> / {suite.name}
      </div>

      <div className="page-head">
        <div>
          <h1>{suite.name}</h1>
          <div className="small muted mono">{suite.baseUrl || 'no base URL'}</div>
        </div>
        <div className="actions">
          <button onClick={runAll} disabled={busy || scripted === 0}>
            {watching ? 'Running…' : `Run suite (${scripted})`}
          </button>
          <button className="danger" onClick={removeSuite}>
            Delete suite
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="row">
          <div>
            <label>Add a test to this suite</label>
            <input
              value={name}
              placeholder="Standard user can log in"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && addTest()}
            />
          </div>
          <div className="shrink">
            <button className="primary" onClick={addTest} disabled={!name.trim() || busy}>
              Add test
            </button>
          </div>
        </div>
      </div>

      {suite.tests.length === 0 ? (
        <div className="empty">No tests in this suite yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Test</th>
              <th style={{ width: 90 }}>Steps</th>
              <th style={{ width: 90 }}>Data</th>
              <th style={{ width: 110 }}>Script</th>
              <th style={{ width: 130 }}>Last run</th>
              <th style={{ width: 100 }} />
            </tr>
          </thead>
          <tbody>
            {suite.tests.map((test) => (
              <tr key={test.id}>
                <td>
                  <Link to={`/tests/${test.id}`}>{test.name}</Link>
                  <div className="small muted mono">{test.url}</div>
                </td>
                <td>{test.stepCount}</td>
                <td>{test.dataCount}</td>
                <td>
                  {test.scriptPath ? (
                    <span className="small muted">{test.scriptOrigin ?? 'saved'}</span>
                  ) : (
                    <span className="small muted">—</span>
                  )}
                </td>
                <td>
                  <StatusBadge status={test.lastRun?.status ?? test.lastRunStatus} />
                  {test.lastRun && (
                    <div className="small muted">{formatWhen(test.lastRun.startedAt)}</div>
                  )}
                </td>
                <td>
                  <Link to={`/tests/${test.id}`}>
                    <button className="ghost">Open</button>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
