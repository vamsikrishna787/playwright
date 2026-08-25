import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type FieldDraft, type StepDraft } from '../api/client';
import DataFieldsEditor from '../components/DataFieldsEditor';
import RunProgress from '../components/RunProgress';
import ScriptPanel from '../components/ScriptPanel';
import StepsEditor from '../components/StepsEditor';
import { StatusBadge, formatWhen } from '../components/StatusBadge';
import { useRunStream } from '../hooks/useRunStream';
import type { Run, TestCase } from '../types';

type Tab = 'data' | 'steps' | 'script' | 'runs';

/**
 * One test, in the order it gets built: the data it needs, the steps it takes,
 * the script an agent writes from those, and what happened when it ran.
 */
export default function TestEditorPage() {
  const { testId = '' } = useParams();
  const navigate = useNavigate();

  const [test, setTest] = useState<TestCase | null>(null);
  const [suiteName, setSuiteName] = useState('');
  const [code, setCode] = useState('');
  const [tab, setTab] = useState<Tab>('data');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const { run: liveRun } = useRunStream(selectedRun);

  const load = useCallback(async () => {
    try {
      const loaded = await api.getTest(testId);
      setTest(loaded);
      setCode(loaded.code);
      // Only for the describe() title in the generated spec.
      api
        .getSuite(loaded.suiteId)
        .then((suite) => setSuiteName(suite.name))
        .catch(() => setSuiteName(''));

      const history = await api.listRuns(testId).catch(() => []);
      setRuns(history);
      setSelectedRun((current) => current ?? history[0]?.id ?? null);

      // Land on the tab that matches how far this test has got.
      setTab((current) =>
        current !== 'data'
          ? current
          : loaded.scriptPath
            ? 'script'
            : loaded.steps.length > 0
              ? 'steps'
              : 'data',
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [testId]);

  useEffect(() => {
    load();
  }, [load]);

  const guard = async (work: () => Promise<void>) => {
    setSaving(true);
    setError('');
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  const saveData = (fields: FieldDraft[]) =>
    guard(async () => setTest(await api.saveData(testId, fields)));

  const saveSteps = (steps: StepDraft[]) =>
    guard(async () => setTest(await api.saveSteps(testId, steps)));

  const start = () =>
    guard(async () => {
      const started = await api.startRun(testId);
      setRuns((current) => [started, ...current]);
      setSelectedRun(started.id);
      setTab('runs');
    });

  const removeTest = async () => {
    if (!test || !confirm(`Delete "${test.name}", its script and its run history?`)) return;
    const { suiteId } = test;
    await api.deleteTest(testId);
    navigate(`/suites/${suiteId}`);
  };

  if (!test) {
    return error ? <div className="error-banner">{error}</div> : <div className="empty">Loading…</div>;
  }

  // The stream is authoritative while a run is open; the list is the fallback
  // for a run that finished before this page was opened.
  const shownRun = liveRun?.id === selectedRun ? liveRun : runs.find((row) => row.id === selectedRun);

  return (
    <div>
      <div className="crumbs">
        <Link to="/">Suites</Link> / <Link to={`/suites/${test.suiteId}`}>{suiteName || 'Suite'}</Link>{' '}
        / {test.name}
      </div>

      <div className="page-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>{test.name}</h1>
          <div className="row" style={{ maxWidth: 620 }}>
            <div>
              <label>Start URL</label>
              <input
                className="mono"
                value={test.url}
                onChange={(event) => setTest({ ...test, url: event.target.value })}
                onBlur={(event) =>
                  guard(async () => setTest(await api.updateTest(testId, { url: event.target.value })))
                }
              />
            </div>
            <div className="shrink" style={{ paddingBottom: 8 }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 0 }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={test.includeAda}
                  onChange={(event) =>
                    guard(async () =>
                      setTest(await api.updateTest(testId, { includeAda: event.target.checked })),
                    )
                  }
                />
                ADA / WCAG test
              </label>
            </div>
          </div>
        </div>

        <div className="actions">
          <StatusBadge status={shownRun?.status ?? test.lastRunStatus} />
          <button
            className="primary"
            onClick={start}
            disabled={saving || !test.scriptPath}
            title={test.scriptPath ? 'Run headless on the server' : 'Generate a script first'}
          >
            Run test
          </button>
          <button className="danger" onClick={removeTest}>
            Delete
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="tabs">
        <button className={tab === 'data' ? 'on' : ''} onClick={() => setTab('data')}>
          Test data <span className="count">{test.dataFields.length}</span>
        </button>
        <button className={tab === 'steps' ? 'on' : ''} onClick={() => setTab('steps')}>
          Steps <span className="count">{test.steps.length}</span>
        </button>
        <button className={tab === 'script' ? 'on' : ''} onClick={() => setTab('script')}>
          Script
          {test.scriptUpdatedAt && (
            <span className="count">{formatWhen(test.scriptUpdatedAt)}</span>
          )}
        </button>
        <button className={tab === 'runs' ? 'on' : ''} onClick={() => setTab('runs')}>
          Runs <span className="count">{runs.length}</span>
        </button>
      </div>

      {tab === 'data' && (
        <DataFieldsEditor fields={test.dataFields} saving={saving} onSave={saveData} />
      )}

      {tab === 'steps' && (
        <StepsEditor
          steps={test.steps}
          dataFields={test.dataFields}
          saving={saving}
          onSave={saveSteps}
        />
      )}

      {tab === 'script' && (
        <ScriptPanel
          test={test}
          suiteName={suiteName}
          code={code}
          onCodeChange={setCode}
          onSaved={(updated) => {
            setTest(updated);
            if ('code' in updated) setCode((updated as { code: string }).code);
          }}
        />
      )}

      {tab === 'runs' && (
        <div className="split">
          <div>
            {shownRun ? (
              <RunProgress run={shownRun} />
            ) : (
              <div className="empty">
                No runs yet. Press Run test to execute the script headless on the server.
              </div>
            )}
          </div>

          <div>
            <h3>History</h3>
            <div className="run-list">
              {runs.length === 0 && <span className="muted small">Nothing yet.</span>}
              {runs.map((run) => (
                <div
                  key={run.id}
                  className={`run-item${run.id === selectedRun ? ' on' : ''}`}
                  onClick={() => setSelectedRun(run.id)}
                >
                  <StatusBadge status={run.id === liveRun?.id ? liveRun.status : run.status} />
                  <span className="muted small" style={{ flex: 1 }}>
                    {formatWhen(run.startedAt)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
