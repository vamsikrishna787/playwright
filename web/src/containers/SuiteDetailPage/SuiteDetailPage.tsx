'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, type FieldDraft } from '../../api/client';
import DataFieldsEditor from '../../components/DataFieldsEditor';
import { StatusBadge, formatWhen } from '../../components/StatusBadge';
import type { SuiteDetail } from '../../types';
import styles from './SuiteDetailPage.module.css';

/**
 * One suite: the tests under it, the data they share, and running the whole set.
 *
 * Data lives here rather than on each test so a login entered once is available
 * to every test in the suite — and changing it changes it everywhere.
 */
export default function SuiteDetailPage({ suiteId }: { suiteId: string }) {
  const router = useRouter();

  const [suite, setSuite] = useState<SuiteDetail | null>(null);
  const [tab, setTab] = useState<'tests' | 'data'>('tests');
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
      router.push(`/tests/${created.id}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };

  const saveData = async (fields: FieldDraft[]) => {
    setBusy(true);
    setError('');
    try {
      await api.saveSuiteData(suiteId, fields);
      // Reloaded rather than merged: removing a field also unhooks it from every
      // step in the suite, so the test rows are stale until they are refetched.
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
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
    router.push('/');
  };

  if (!suite) {
    return error ? (
      <div className="error-banner">{error}</div>
    ) : (
      <div className="empty">Loading…</div>
    );
  }

  const scripted = suite.tests.filter((test) => test.scriptPath).length;

  return (
    <div>
      <div className="crumbs">
        <Link href="/">Suites</Link> / {suite.name}
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

      <div className="tabs">
        <button className={tab === 'tests' ? 'on' : ''} onClick={() => setTab('tests')}>
          Tests <span className="count">{suite.tests.length}</span>
        </button>
        <button className={tab === 'data' ? 'on' : ''} onClick={() => setTab('data')}>
          Test data <span className="count">{suite.dataFields.length}</span>
        </button>
      </div>

      {tab === 'data' ? (
        <DataFieldsEditor fields={suite.dataFields} saving={busy} onSave={saveData} />
      ) : (
        <>
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
                  <th className={styles.narrow}>Steps</th>
                  <th className={styles.medium}>Data used</th>
                  <th className={styles.medium}>Script</th>
                  <th className={styles.wide}>Last run</th>
                  <th className={styles.medium} />
                </tr>
              </thead>
              <tbody>
                {suite.tests.map((test) => (
                  <tr key={test.id}>
                    <td>
                      <Link href={`/tests/${test.id}`}>{test.name}</Link>
                      <div className="small muted mono">{test.url}</div>
                    </td>
                    <td>{test.stepCount}</td>
                    <td>
                      {test.dataUsed}
                      <span className="small muted"> of {suite.dataFields.length}</span>
                    </td>
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
                      <Link href={`/tests/${test.id}`}>
                        <button className="ghost">Open</button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
