'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, type StepDraft } from '../../api/client';
import RunProgress from '../../components/RunProgress';
import ScriptPanel from '../../components/ScriptPanel';
import StepsEditor from '../../components/StepsEditor';
import { StatusBadge, formatWhen } from '../../components/StatusBadge';
import { useRunStream } from '../../hooks/useRunStream';
import type { Run, SuiteDetail, TestCase } from '../../types';
import styles from './TestEditorPage.module.css';

type Tab = 'steps' | 'script' | 'runs';

/**
 * One test, in the order it gets built: the steps it takes, the script an agent
 * writes from those, and what happened when it ran.
 *
 * The data those steps reference belongs to the suite, not here — it is shared
 * with every other test under it, so it is edited on the suite page.
 */
export default function TestEditorPage({ testId }: { testId: string }) {
  const router = useRouter();

  const [test, setTest] = useState<TestCase | null>(null);
  const [suite, setSuite] = useState<SuiteDetail | null>(null);
  const [code, setCode] = useState('');
  const [tab, setTab] = useState<Tab>('steps');
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
      // The suite carries the shared data pool the steps reference, and the
      // name the generated spec uses for its describe() block.
      api
        .getSuite(loaded.suiteId)
        .then(setSuite)
        .catch(() => setSuite(null));

      const history = await api.listRuns(testId).catch(() => []);
      setRuns(history);
      setSelectedRun((current) => current ?? history[0]?.id ?? null);

      // Land on the tab that matches how far this test has got.
      setTab((current) => (current !== 'steps' ? current : loaded.scriptPath ? 'script' : 'steps'));
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
    router.push(`/suites/${suiteId}`);
  };

  if (!test) {
    return error ? (
      <div className="error-banner">{error}</div>
    ) : (
      <div className="empty">Loading…</div>
    );
  }

  // The stream is authoritative while a run is open; the list is the fallback
  // for a run that finished before this page was opened.
  const shownRun =
    liveRun?.id === selectedRun ? liveRun : runs.find((row) => row.id === selectedRun);

  return (
    <div>
      <div className="crumbs">
        <Link href="/">Suites</Link> /{' '}
        <Link href={`/suites/${test.suiteId}`}>{suite?.name || 'Suite'}</Link> / {test.name}
      </div>

      <div className="page-head">
        <div className={styles.grow}>
          <h1>{test.name}</h1>
          <div className={`row ${styles.url}`}>
            <div>
              <label>Start URL</label>
              <input
                className="mono"
                value={test.url}
                onChange={(event) => setTest({ ...test, url: event.target.value })}
                onBlur={(event) =>
                  guard(async () =>
                    setTest(await api.updateTest(testId, { url: event.target.value })),
                  )
                }
              />
            </div>
            <div className="shrink" style={{ paddingBottom: 8 }}>
              <label className={styles.adaLabel}>
                <input
                  type="checkbox"
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
        <button className={tab === 'steps' ? 'on' : ''} onClick={() => setTab('steps')}>
          Steps <span className="count">{test.steps.length}</span>
        </button>
        <button className={tab === 'script' ? 'on' : ''} onClick={() => setTab('script')}>
          Script
          {test.scriptUpdatedAt && <span className="count">{formatWhen(test.scriptUpdatedAt)}</span>}
        </button>
        <button className={tab === 'runs' ? 'on' : ''} onClick={() => setTab('runs')}>
          Runs <span className="count">{runs.length}</span>
        </button>
      </div>

      {tab === 'steps' && (
        <StepsEditor
          steps={test.steps}
          dataFields={suite?.dataFields ?? []}
          suiteId={test.suiteId}
          saving={saving}
          onSave={saveSteps}
        />
      )}

      {tab === 'script' && (
        <ScriptPanel
          test={test}
          suiteName={suite?.name ?? ''}
          code={code}
          onCodeChange={setCode}
          onSaved={(updated) => {
            setTest(updated);
            if ('code' in updated) setCode((updated as { code: string }).code);
          }}
        />
      )}

      {tab === 'runs' && (
        <div className={styles.split}>
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
            <div className={styles.runList}>
              {runs.length === 0 && <span className="muted small">Nothing yet.</span>}
              {runs.map((run) => (
                <div
                  key={run.id}
                  className={`${styles.runItem} ${run.id === selectedRun ? styles.selected : ''}`}
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
