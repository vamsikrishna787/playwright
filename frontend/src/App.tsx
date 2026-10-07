import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, AUTH_REQUIRED, getToken, setToken, type Suite } from './api';
import { EmptyState, StatusBadge, SuiteDialog, ToastProvider } from './components';
import { navigate, notifySuitesChanged, paths, usePolledResource, useRoute, useSuitesChanged } from './lib';
import { SuitePage } from './SuitePage';
import { TestPage } from './TestPage';

export default function App() {
  // The app is open by default. The token screen only appears if the API asks for one (401).
  const [needsToken, setNeedsToken] = useState(false);
  useEffect(() => {
    const onAuthRequired = () => setNeedsToken(true);
    window.addEventListener(AUTH_REQUIRED, onAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED, onAuthRequired);
  }, []);
  return (
    <ToastProvider>
      {needsToken ? (
        <TokenGate
          onToken={(t) => {
            setToken(t);
            setNeedsToken(false);
          }}
        />
      ) : (
        <Shell
          hasToken={!!getToken()}
          onSignOut={() => {
            setToken('');
            setNeedsToken(true);
          }}
        />
      )}
    </ToastProvider>
  );
}

function TokenGate({ onToken }: { onToken: (token: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setChecking(true);
    setError(null);
    try {
      await api.verifyToken(value.trim());
      onToken(value.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setChecking(false);
    }
  };

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <Logo />
        <h1>Connect to your workspace</h1>
        <p className="muted">This deployment requires an access token. Ask the site owner for it. It is kept in this browser only.</p>
        <input type="password" autoFocus required value={value} onChange={(e) => setValue(e.target.value)} placeholder="API token" aria-label="API token" />
        {error && <div className="alert alert-danger">{error}</div>}
        <button className="btn btn-primary" disabled={checking}>
          {checking ? 'Checking…' : 'Continue'}
        </button>
      </form>
    </div>
  );
}

function Logo() {
  return (
    <div className="logo">
      <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden>
        <rect width="32" height="32" rx="8" fill="var(--accent)" />
        <rect x="6" y="8" width="20" height="16" rx="3" fill="none" stroke="var(--accent-contrast)" strokeWidth="2" />
        <path d="M6 13h20" stroke="var(--accent-contrast)" strokeWidth="2" />
        <circle cx="9.5" cy="10.5" r="1" fill="var(--accent-contrast)" />
        <circle cx="12.5" cy="10.5" r="1" fill="var(--accent-contrast)" />
      </svg>
      <span>Browser Automation Lab</span>
    </div>
  );
}

function Shell({ hasToken, onSignOut }: { hasToken: boolean; onSignOut: () => void }) {
  const route = useRoute();
  const [creating, setCreating] = useState(false);
  const suites = usePolledResource(
    api.listSuites,
    'suites',
    (list) => list.some((s) => s.status === 'running'),
    8000,
  );
  useSuitesChanged(suites.refresh);
  const activeSuiteId = route.page === 'home' ? null : route.suiteId;

  const onCreated = useCallback((suite: Suite) => {
    setCreating(false);
    notifySuitesChanged();
    navigate(paths.suite(suite.id));
  }, []);

  return (
    <div className="layout">
      <aside className="sidebar">
        <a href={paths.home()} className="sidebar-brand">
          <Logo />
        </a>
        <div className="sidebar-section">
          <span>Test suites</span>
          <button className="icon-btn" onClick={() => setCreating(true)} aria-label="New suite" title="New suite">
            +
          </button>
        </div>
        <nav className="suite-nav">
          {suites.loading && <div className="muted pad">Loading…</div>}
          {suites.error && <div className="alert alert-danger">{suites.error}</div>}
          {suites.data?.map((s) => (
            <a key={s.id} href={paths.suite(s.id)} className={`suite-link ${s.id === activeSuiteId ? 'active' : ''}`}>
              <span className={`status-dot status-${s.status}`} aria-hidden />
              <span className="suite-link-name">{s.name}</span>
              <span className="suite-link-count">
                {s.counts.passed}/{s.counts.total}
              </span>
            </a>
          ))}
          {suites.data?.length === 0 && (
            <button className="btn btn-primary btn-block" onClick={() => setCreating(true)}>
              Create your first suite
            </button>
          )}
        </nav>
        <div className="sidebar-footer">
          {hasToken ? (
            <button className="link-btn" onClick={onSignOut}>
              Change access token
            </button>
          ) : (
            <a className="link-btn small" href="https://opensuperlab.com" target="_blank" rel="noreferrer">
              An OpenSuperLab open source project
            </a>
          )}
        </div>
      </aside>

      <main className="main">
        {route.page === 'home' && <Home suites={suites.data} onCreate={() => setCreating(true)} />}
        {route.page === 'suite' && <SuitePage suiteId={route.suiteId} />}
        {route.page === 'new-test' && <TestPage suiteId={route.suiteId} />}
        {route.page === 'test' && <TestPage suiteId={route.suiteId} testId={route.testId} runId={route.runId} />}
      </main>

      {creating && <SuiteDialog onClose={() => setCreating(false)} onSaved={onCreated} />}
    </div>
  );
}

function Home({ suites, onCreate }: { suites: Suite[] | null; onCreate: () => void }) {
  const totals = (suites ?? []).reduce(
    (acc, s) => ({
      tests: acc.tests + s.counts.total,
      ready: acc.ready + s.counts.ready,
      passed: acc.passed + s.counts.passed,
      failed: acc.failed + s.counts.failed,
    }),
    { tests: 0, ready: 0, passed: 0, failed: 0 },
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Overview</h1>
          <p className="muted">Describe tests in plain language. AI turns them into verified Playwright scripts that run on demand.</p>
        </div>
        <button className="btn btn-primary" onClick={onCreate}>
          New suite
        </button>
      </header>

      <div className="stats">
        <Stat label="Suites" value={suites?.length ?? '-'} />
        <Stat label="Test cases" value={totals.tests} />
        <Stat label="Scripts ready" value={totals.ready} />
        <Stat label="Passing" value={totals.passed} tone="success" />
        <Stat label="Failing" value={totals.failed} tone={totals.failed ? 'danger' : undefined} />
      </div>

      <ol className="how">
        <li>
          <strong>Create a suite</strong>
          <span>Group related tests and set a base URL.</span>
        </li>
        <li>
          <strong>Write test cases</strong>
          <span>Add steps, the expected result, and data points such as usernames.</span>
        </li>
        <li>
          <strong>Generate</strong>
          <span>Claude on Bedrock performs the steps through Playwright MCP and keeps only a script that passes.</span>
        </li>
        <li>
          <strong>Run</strong>
          <span>Verified scripts run in Lambda and produce video, trace and Lighthouse reports.</span>
        </li>
      </ol>

      {suites && suites.length > 0 ? (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Suite</th>
                <th>Status</th>
                <th>Tests</th>
                <th>Scripts ready</th>
                <th>Passed</th>
                <th>Failed</th>
              </tr>
            </thead>
            <tbody>
              {suites.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => navigate(paths.suite(s.id))}>
                  <td>
                    <a href={paths.suite(s.id)}>{s.name}</a>
                    {s.baseUrl && <div className="muted small">{s.baseUrl}</div>}
                  </td>
                  <td>
                    <StatusBadge status={s.status} />
                  </td>
                  <td>{s.counts.total}</td>
                  <td>{s.counts.ready}</td>
                  <td>{s.counts.passed}</td>
                  <td>{s.counts.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        suites && (
          <EmptyState title="No suites yet">
            <button className="btn btn-primary" onClick={onCreate}>
              Create a suite
            </button>
          </EmptyState>
        )
      )}
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
