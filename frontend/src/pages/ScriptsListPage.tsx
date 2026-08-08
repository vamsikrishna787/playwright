import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import RunStatusBadge from '../components/RunStatusBadge';
import type { DomainSummary, RunRecord, ScriptRecord } from '../types';

const isActive = (run?: RunRecord) => run?.status === 'queued' || run?.status === 'running';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export default function ScriptsListPage() {
  const navigate = useNavigate();
  const [domains, setDomains] = useState<DomainSummary[] | null>(null);
  const [scripts, setScripts] = useState<ScriptRecord[]>([]);
  const [latest, setLatest] = useState<Record<string, RunRecord>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [adding, setAdding] = useState(false);

  const loadLatest = useCallback(async () => {
    const map = await api.latestRuns();
    setLatest(map);
    return map;
  }, []);

  const load = useCallback(async () => {
    const [sites, all] = await Promise.all([api.listDomains(), api.listScripts()]);
    setDomains(sites);
    setScripts(all);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(message(err)));
    loadLatest().catch(() => {});
  }, [load, loadLatest]);

  // Keep the status column live while anything is still queued or running.
  useEffect(() => {
    if (!Object.values(latest).some(isActive)) {
      setRunningAll(false);
      return;
    }
    const timer = window.setTimeout(() => loadLatest().catch(() => {}), 2000);
    return () => window.clearTimeout(timer);
  }, [latest, loadLatest]);

  const grouped = useMemo(() => {
    const byDomain = new Map<string, ScriptRecord[]>();
    for (const script of scripts) {
      byDomain.set(script.domainId, [...(byDomain.get(script.domainId) ?? []), script]);
    }
    return byDomain;
  }, [scripts]);

  const addSite = async () => {
    const url = newUrl.trim();
    if (!url) return;
    setAdding(true);
    setError(null);
    try {
      const domain = await api.addDomain(url);
      // Straight into recording: adding a site is only ever a step towards a script.
      navigate(`/domains/${domain.id}/record?url=${encodeURIComponent(url)}`);
    } catch (err) {
      setError(message(err));
      setAdding(false);
    }
  };

  const run = async (scriptId: string) => {
    setBusyId(scriptId);
    try {
      const started = await api.startRun(scriptId);
      navigate(`/scripts/${scriptId}/runs/${started.id}`);
    } catch (err) {
      setError(message(err));
      setBusyId(null);
    }
  };

  const runAll = async (domainId?: string) => {
    setRunningAll(true);
    setError(null);
    try {
      const started = await api.runAll(domainId);
      setLatest((current) => ({
        ...current,
        ...Object.fromEntries(started.map((r) => [r.scriptId, r])),
      }));
    } catch (err) {
      setError(message(err));
      setRunningAll(false);
    }
  };

  const removeScript = async (script: ScriptRecord) => {
    if (!window.confirm(`Delete "${script.name}" and all of its run history?`)) return;
    setBusyId(script.id);
    try {
      await api.deleteScript(script.id);
      setScripts((current) => current.filter((s) => s.id !== script.id));
      setLatest(({ [script.id]: _removed, ...rest }) => rest);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusyId(null);
    }
  };

  const removeDomain = async (domain: DomainSummary) => {
    const count = grouped.get(domain.id)?.length ?? 0;
    const warning =
      `Delete ${domain.name}? This removes ${count} script${count === 1 ? '' : 's'}, ` +
      `their run history, and ${domain.locatorCount} saved locators.`;
    if (!window.confirm(warning)) return;

    setBusyId(domain.id);
    try {
      await api.deleteDomain(domain.id);
      setDomains((current) => (current ?? []).filter((d) => d.id !== domain.id));
      setScripts((current) => current.filter((s) => s.domainId !== domain.id));
    } catch (err) {
      setError(message(err));
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
            Grouped by site. Each site keeps its own library of recorded locators, so every new
            script starts from what earlier ones already proved.
          </p>
        </div>
        <div className="row">
          <button onClick={() => runAll()} disabled={runningAll || scripts.length === 0}>
            {runningAll ? (
              <>
                <span className="spinner" />
                {activeCount} running…
              </>
            ) : (
              'Run all'
            )}
          </button>
        </div>
      </div>

      <div className="card add-site">
        <div className="field" style={{ margin: 0, flex: 1 }}>
          <label htmlFor="new-site">Add a site</label>
          <input
            id="new-site"
            type="text"
            placeholder="https://www.saucedemo.com/"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addSite()}
          />
        </div>
        <button className="primary" onClick={addSite} disabled={adding || !newUrl.trim()}>
          {adding ? 'Opening…' : 'Add and record'}
        </button>
      </div>

      {error && (
        <div className="error-box" style={{ marginTop: 20 }}>
          {error}
        </div>
      )}

      {domains === null && <p className="muted">Loading…</p>}

      {domains?.length === 0 && (
        <div className="card empty" style={{ marginTop: 24 }}>
          <p>No sites yet.</p>
          <p className="muted">Add a URL above — a browser opens and you walk the flow once.</p>
        </div>
      )}

      {domains?.map((domain) => {
        const owned = grouped.get(domain.id) ?? [];
        return (
          <section key={domain.id} className="domain">
            <div className="domain-head">
              <div>
                <h2 className="domain-name">
                  {domain.name}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    {' '}
                    · {owned.length} script{owned.length === 1 ? '' : 's'}
                  </span>
                </h2>
                <Link className="mono muted domain-meta" to={`/domains/${domain.id}/locators`}>
                  {domain.locatorCount} locators across {domain.pageCount} page
                  {domain.pageCount === 1 ? '' : 's'}
                  {domain.verifiedCount > 0 && ` · ${domain.verifiedCount} verified`}
                </Link>
              </div>
              <div className="row">
                <Link to={`/domains/${domain.id}/generate`}>
                  <button className="primary">Generate with AI</button>
                </Link>
                <Link to={`/domains/${domain.id}/record`}>
                  <button className="primary">Record</button>
                </Link>
                <button
                  onClick={() => runAll(domain.id)}
                  disabled={runningAll || owned.length === 0}
                >
                  Run all
                </button>
                <button
                  className="danger"
                  onClick={() => removeDomain(domain)}
                  disabled={busyId === domain.id}
                >
                  Delete
                </button>
              </div>
            </div>

            {owned.length === 0 ? (
              <div className="card empty domain-empty">
                No scripts for this site yet — record a flow, or generate one from its{' '}
                {domain.locatorCount} saved locators.
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th style={{ width: 90 }}>Made by</th>
                    <th>Last run</th>
                    <th style={{ width: 110 }}>Created</th>
                    <th style={{ width: 220 }} />
                  </tr>
                </thead>
                <tbody>
                  {owned.map((script) => {
                    const lastRun = latest[script.id];
                    return (
                      <tr key={script.id}>
                        <td>
                          <Link to={`/scripts/${script.id}`}>{script.name}</Link>
                          <div className="mono muted" style={{ fontSize: 11 }}>
                            {script.sourceUrl}
                          </div>
                        </td>
                        <td className="muted">
                          {script.origin === 'ai' ? 'AI' : 'Recording'}
                        </td>
                        <td>
                          {lastRun ? (
                            <Link to={`/scripts/${script.id}/runs/${lastRun.id}`}>
                              <RunStatusBadge status={lastRun.status} />
                            </Link>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="muted">
                          {new Date(script.createdAt).toLocaleDateString()}
                        </td>
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
                              <button>Open</button>
                            </Link>
                            <button
                              className="danger"
                              onClick={() => removeScript(script)}
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
          </section>
        );
      })}
    </>
  );
}
