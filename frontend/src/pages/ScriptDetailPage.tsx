import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import ChatPanel from '../components/ChatPanel';
import CodeEditor from '../components/CodeEditor';
import RunResult from '../components/RunResult';
import RunStatusBadge from '../components/RunStatusBadge';
import StepsView from '../components/StepsView';
import { usePollRun } from '../hooks/usePollRun';
import type { RunRecord, ScriptRecord, ScriptStep } from '../types';

type View = 'steps' | 'script';

export default function ScriptDetailPage() {
  const { id } = useParams<{ id: string }>();

  const [script, setScript] = useState<ScriptRecord | null>(null);
  const [code, setCode] = useState('');
  const [savedCode, setSavedCode] = useState('');
  const [steps, setSteps] = useState<ScriptStep[]>([]);
  const [stepsLoading, setStepsLoading] = useState(false);
  // Steps first: it is the view that needs no Playwright knowledge to read.
  const [view, setView] = useState<View>('steps');
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const { run: activeRun } = usePollRun(activeRunId ?? undefined);
  const testing = activeRun?.status === 'queued' || activeRun?.status === 'running';

  const loadRuns = useCallback(async (scriptId: string) => {
    const list = await api.listRuns(scriptId);
    setRuns(list);
    return list;
  }, []);

  useEffect(() => {
    if (!id) return;
    api
      .getScript(id)
      .then((data) => {
        setScript(data);
        setCode(data.code);
        setSavedCode(data.code);
        setSteps(data.steps);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    loadRuns(id).catch(() => {});
  }, [id, loadRuns]);

  // Re-read the steps whenever the code changes — including edits that are not
  // saved yet, so the two views never describe different tests. Debounced,
  // because this fires on every keystroke in the editor.
  useEffect(() => {
    if (!script || code === savedCode) return;
    setStepsLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const { steps: parsed } = await api.previewSteps(code);
        setSteps(parsed);
      } catch {
        /* leave the last good reading in place */
      } finally {
        setStepsLoading(false);
      }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [code, savedCode, script]);

  // Keep the history fresh while any run is still in flight.
  useEffect(() => {
    if (!id || !runs.some((r) => r.status === 'running' || r.status === 'queued')) return;
    const timer = window.setTimeout(() => loadRuns(id).catch(() => {}), 2000);
    return () => window.clearTimeout(timer);
  }, [id, runs, loadRuns]);

  const save = async () => {
    if (!id) return;
    setSaving(true);
    setError(null);
    try {
      await api.updateScript(id, { code });
      setSavedCode(code);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // Runs whatever is in the editor right now and reports back on this page.
  // The code is written to disk first because the runner executes the spec file.
  const testScript = async () => {
    if (!id) return;
    setStarting(true);
    setError(null);
    try {
      if (code !== savedCode) {
        await api.updateScript(id, { code });
        setSavedCode(code);
      }
      const started = await api.startRun(id);
      setActiveRunId(started.id);
      loadRuns(id).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  if (error && !script) return <div className="error-box">{error}</div>;
  if (!script) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="spread">
        <div>
          <h1>{script.name}</h1>
          <p className="subtitle mono" style={{ marginBottom: 0 }}>
            {script.sourceUrl}
          </p>
        </div>
        <div className="row">
          <button onClick={save} disabled={saving || code === savedCode}>
            {saving ? 'Saving…' : code === savedCode ? 'Saved' : 'Save changes'}
          </button>
          <button className="primary" onClick={testScript} disabled={starting || testing}>
            {starting || testing ? (
              <>
                <span className="spinner" />
                {testing ? 'Testing…' : 'Starting…'}
              </>
            ) : (
              'Test script'
            )}
          </button>
        </div>
      </div>

      {error && <div className="error-box" style={{ marginTop: 16 }}>{error}</div>}

      <div className="editor-grid">
        <section>
          <div className="spread" style={{ marginBottom: 12 }}>
            <div className="tabs">
              <button
                className={view === 'steps' ? 'tab active' : 'tab'}
                onClick={() => setView('steps')}
              >
                Steps
              </button>
              <button
                className={view === 'script' ? 'tab active' : 'tab'}
                onClick={() => setView('script')}
              >
                Script
              </button>
            </div>
            <span className="muted">
              {view === 'steps'
                ? 'What the test does, in plain English'
                : 'The Playwright file that runs'}
            </span>
          </div>

          {view === 'steps' ? (
            <StepsView steps={steps} loading={stepsLoading} />
          ) : (
            <CodeEditor value={code} onChange={setCode} height={520} />
          )}
        </section>
        <section>
          <h2>Enhance with AI</h2>
          <ChatPanel scriptId={script.id} code={code} onApply={setCode} />
        </section>
      </div>

      {activeRun && (
        <>
          <div className="spread" style={{ marginTop: 28 }}>
            <h2 style={{ margin: 0 }}>
              Test result
              {activeRun.durationMs !== null && (
                <span className="muted"> · {(activeRun.durationMs / 1000).toFixed(1)}s</span>
              )}
            </h2>
            <div className="row">
              <RunStatusBadge status={activeRun.status} />
              <Link to={`/scripts/${script.id}/runs/${activeRun.id}`}>Open full page</Link>
              <button onClick={() => setActiveRunId(null)} disabled={testing}>
                Dismiss
              </button>
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <RunResult run={activeRun} />
          </div>
        </>
      )}

      <h2>Run history</h2>
      {runs.length === 0 ? (
        <div className="card empty">No runs yet. Click “Run test” to execute this script.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Started</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Steps</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.startedAt).toLocaleString()}</td>
                <td>
                  <RunStatusBadge status={r.status} />
                </td>
                <td className="muted">{r.durationMs !== null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                <td className="muted">{r.steps.length || '—'}</td>
                <td style={{ textAlign: 'right' }}>
                  <Link to={`/scripts/${script.id}/runs/${r.id}`}>View run</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
