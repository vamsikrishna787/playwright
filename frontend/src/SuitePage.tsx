import { useState } from 'react';
import { api, type RunOptions, type Suite, type TestCase } from './api';
import { Stat } from './App';
import { EmptyState, PerfChip, ScriptBadge, StatusBadge, SuiteDialog, useToast } from './components';
import { formatDuration, isActive, navigate, notifySuitesChanged, paths, runInProgress, timeAgo, usePolledResource } from './lib';

const suiteIsBusy = (s: Suite) =>
  (s.tests ?? []).some((t) => t.scriptStatus === 'generating' || runInProgress(t.lastRun));

export function SuitePage({ suiteId }: { suiteId: string }) {
  const toast = useToast();
  const suite = usePolledResource(() => api.getSuite(suiteId), suiteId, suiteIsBusy);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [runOptions, setRunOptions] = useState<RunOptions>({ lighthouse: true, lighthousePreset: 'desktop' });

  const act = async (label: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(label);
    try {
      await fn();
      toast('success', success);
      suite.refresh();
      notifySuitesChanged();
    } catch (err) {
      toast('danger', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (suite.error) return <div className="page"><div className="alert alert-danger">{suite.error}</div></div>;
  if (!suite.data) return <div className="page muted">Loading suite…</div>;
  const s = suite.data;
  const tests = s.tests ?? [];

  const runSuite = () =>
    act('run-suite', async () => {
      const res = await api.runSuite(s.id, runOptions);
      if (!res.started.length) throw new Error('No tests with a ready script to run');
    }, 'Suite run started');

  const deleteSuite = async () => {
    if (!confirm(`Delete suite "${s.name}" with all its tests, scripts and run reports?`)) return;
    await act('delete', () => api.deleteSuite(s.id), 'Suite deleted');
    navigate(paths.home());
  };

  return (
    <div className="page">
      <nav className="crumbs">
        <a href={paths.home()}>Suites</a> / <span>{s.name}</span>
      </nav>
      <header className="page-header">
        <div>
          <h1>
            {s.name} <StatusBadge status={s.status} />
          </h1>
          {s.description && <p className="muted">{s.description}</p>}
          {s.baseUrl && (
            <a className="small" href={s.baseUrl} target="_blank" rel="noreferrer">
              {s.baseUrl}
            </a>
          )}
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button className="btn btn-danger-ghost" onClick={deleteSuite} disabled={!!busy}>
            Delete
          </button>
          <button className="btn btn-primary" onClick={() => navigate(paths.newTest(s.id))}>
            New test
          </button>
        </div>
      </header>

      <div className="stats">
        <Stat label="Test cases" value={s.counts.total} />
        <Stat label="Scripts ready" value={s.counts.ready} />
        <Stat label="Generating" value={s.counts.generating} />
        <Stat label="Passed" value={s.counts.passed} tone="success" />
        <Stat label="Failed" value={s.counts.failed} tone={s.counts.failed ? 'danger' : undefined} />
      </div>

      <div className="toolbar">
        <RunOptionsPicker value={runOptions} onChange={setRunOptions} />
        <button className="btn btn-primary" onClick={runSuite} disabled={!!busy || s.counts.ready === 0}>
          {busy === 'run-suite' ? 'Starting…' : `Run suite (${s.counts.ready})`}
        </button>
      </div>

      {tests.length === 0 ? (
        <EmptyState title="No test cases yet">
          <p className="muted">Write the steps in plain language, then generate a Playwright script.</p>
          <button className="btn btn-primary" onClick={() => navigate(paths.newTest(s.id))}>
            Create a test
          </button>
        </EmptyState>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Test case</th>
                <th>Script</th>
                <th>Last run</th>
                <th>Duration</th>
                <th title="Lighthouse performance">Perf</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tests.map((t) => (
                <TestRow key={t.id} test={t} runOptions={runOptions} busy={busy} act={act} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <SuiteDialog
          suite={s}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            suite.refresh();
            notifySuitesChanged();
          }}
        />
      )}
    </div>
  );
}

function TestRow({
  test: t,
  runOptions,
  busy,
  act,
}: {
  test: TestCase;
  runOptions: RunOptions;
  busy: string | null;
  act: (label: string, fn: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const hasScript = t.scriptStatus === 'ready' || t.scriptStatus === 'stale';
  const running = isActive(t.lastRun?.status);
  return (
    <tr className="clickable" onClick={() => navigate(paths.test(t.suiteId, t.id))}>
      <td>
        <a href={paths.test(t.suiteId, t.id)}>{t.name}</a>
        <div className="muted small">
          {t.steps.length} steps · {t.dataPoints.length} data points
        </div>
      </td>
      <td>
        <ScriptBadge status={t.scriptStatus} />
      </td>
      <td>
        {t.lastRun ? (
          <>
            <StatusBadge status={t.lastRun.status} />
            <div className="muted small">{timeAgo(t.lastRun.finishedAt ?? t.lastRun.queuedAt)}</div>
          </>
        ) : (
          <span className="muted">Never</span>
        )}
      </td>
      <td>{formatDuration(t.lastRun?.durationMs)}</td>
      <td>
        <PerfChip scores={t.lastRun?.lighthouseScores} />
      </td>
      <td className="right" onClick={(e) => e.stopPropagation()}>
        <div className="row-actions">
          <button
            className="btn btn-sm"
            disabled={!!busy || t.scriptStatus === 'generating'}
            onClick={() => act(`gen-${t.id}`, () => api.generate(t.suiteId, t.id), `Generating script for "${t.name}"`)}
          >
            {hasScript ? 'Regenerate' : 'Generate'}
          </button>
          <button
            className="btn btn-sm btn-primary"
            disabled={!!busy || !hasScript || running}
            onClick={() => act(`run-${t.id}`, () => api.runTest(t.suiteId, t.id, runOptions), `Run started for "${t.name}"`)}
          >
            Run
          </button>
        </div>
      </td>
    </tr>
  );
}

export function RunOptionsPicker({ value, onChange }: { value: RunOptions; onChange: (v: RunOptions) => void }) {
  return (
    <div className="run-options">
      <label className="checkbox">
        <input type="checkbox" checked={value.lighthouse} onChange={(e) => onChange({ ...value, lighthouse: e.target.checked })} />
        Lighthouse audit
      </label>
      <select
        aria-label="Lighthouse device"
        value={value.lighthousePreset}
        disabled={!value.lighthouse}
        onChange={(e) => onChange({ ...value, lighthousePreset: e.target.value as RunOptions['lighthousePreset'] })}
      >
        <option value="desktop">Desktop</option>
        <option value="mobile">Mobile</option>
      </select>
    </div>
  );
}
