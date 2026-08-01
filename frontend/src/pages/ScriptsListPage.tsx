import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import RunStatusBadge from '../components/RunStatusBadge';
import type { RunRecord, ScriptRecord } from '../types';

const isActive = (run?: RunRecord) => run?.status === 'queued' || run?.status === 'running';

export default function ScriptsListPage() {
  const navigate = useNavigate();
  const [scripts, setScripts] = useState<ScriptRecord[] | null>(null);
  const [latest, setLatest] = useState<Record<string, RunRecord>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);

  const loadLatest = useCallback(async () => {
    const map = await api.latestRuns();
    setLatest(map);
    return map;
  }, []);

  useEffect(() => {
    api
      .listScripts()
      .then(setScripts)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    loadLatest().catch(() => {});
  }, [loadLatest]);

  // Keep the status column live while anything is still queued or running.
  useEffect(() => {
    if (!Object.values(latest).some(isActive)) {
      setRunningAll(false);
      return;
    }
    const timer = window.setTimeout(() => loadLatest().catch(() => {}), 2000);
    return () => window.clearTimeout(timer);
  }, [latest, loadLatest]);

  const run = async (scriptId: string) => {
    setBusyId(scriptId);
    try {
      const started = await api.startRun(scriptId);
      navigate(`/scripts/${scriptId}/runs/${started.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusyId(null);
    }
  };

  const runAll = async () => {
    setRunningAll(true);
    setError(null);
    try {
      const started = await api.runAll();
      setLatest(Object.fromEntries(started.map((r) => [r.scriptId, r])));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunningAll(false);
    }
  };

  const remove = async (script: ScriptRecord) => {
    if (!window.confirm(`Delete "${script.name}" and all of its run history?`)) return;
    setBusyId(script.id);
    try {
      await api.deleteScript(script.id);
      setScripts((current) => (current ?? []).filter((s) => s.id !== script.id));
      setLatest(({ [script.id]: _removed, ...rest }) => rest);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const activeCount = Object.values(latest).filter(isActive).length;

  return (
    <>
      <div className="spread">
        <div>
          <h1>My Scripts</h1>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            Generated Playwright tests. Each run records its own video and results.
          </p>
        </div>
        <div className="row">
          <button onClick={runAll} disabled={runningAll || !scripts?.length}>
            {runningAll ? (
              <>
                <span className="spinner" />
                {activeCount} running…
              </>
            ) : (
              'Run all'
            )}
          </button>
          <Link to="/new">
            <button className="primary">New test</button>
          </Link>
        </div>
      </div>

      {error && (
        <div className="error-box" style={{ marginTop: 20 }}>
          {error}
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        {scripts === null && <p className="muted">Loading…</p>}

        {scripts?.length === 0 && (
          <div className="card empty">
            <p>No scripts yet.</p>
            <Link to="/new">Generate your first test</Link>
          </div>
        )}

        {scripts && scripts.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Source URL</th>
                <th>Last run</th>
                <th>Created</th>
                <th style={{ width: 220 }} />
              </tr>
            </thead>
            <tbody>
              {scripts.map((script) => {
                const run_ = latest[script.id];
                return (
                  <tr key={script.id}>
                    <td>
                      <Link to={`/scripts/${script.id}`}>{script.name}</Link>
                    </td>
                    <td className="mono muted">{script.sourceUrl}</td>
                    <td>
                      {run_ ? (
                        <Link to={`/scripts/${script.id}/runs/${run_.id}`}>
                          <RunStatusBadge status={run_.status} />
                        </Link>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="muted">{new Date(script.createdAt).toLocaleDateString()}</td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button
                          className="primary"
                          onClick={() => run(script.id)}
                          disabled={busyId === script.id}
                        >
                          Run
                        </button>
                        <Link to={`/scripts/${script.id}`}>
                          <button>Edit</button>
                        </Link>
                        <button
                          className="danger"
                          onClick={() => remove(script)}
                          disabled={busyId === script.id}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
