import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api/client';
import SuitesPage from './pages/SuitesPage';
import SuiteDetailPage from './pages/SuiteDetailPage';
import TestEditorPage from './pages/TestEditorPage';

/**
 * Whether the Python tier is answering.
 *
 * Worth a permanent corner of the header: "Generate does nothing" is almost
 * always that process not being up, and without this the only clue is an error
 * on a button press a minute into writing a test.
 */
function AgentState() {
  const [state, setState] = useState<'checking' | 'up' | 'down'>('checking');

  useEffect(() => {
    let cancelled = false;
    const check = () =>
      api
        .health()
        .then((body) => !cancelled && setState(body.agentApi.reachable ? 'up' : 'down'))
        .catch(() => !cancelled && setState('down'));

    check();
    const timer = setInterval(check, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const label =
    state === 'checking' ? 'checking agents…' : state === 'up' ? 'agents ready' : 'agents offline';
  const colour = state === 'up' ? 'var(--pass)' : state === 'down' ? 'var(--fail)' : 'var(--muted)';

  return (
    <span className="agent-state" title="The Python agent API at :8000">
      <span className="dot" style={{ color: colour }} />
      {label}
    </span>
  );
}

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          Playwright Test Platform
        </Link>
        <span className="spacer" />
        <AgentState />
      </header>

      <main className="container">
        <Routes>
          <Route path="/" element={<SuitesPage />} />
          <Route path="/suites/:suiteId" element={<SuiteDetailPage />} />
          <Route path="/tests/:testId" element={<TestEditorPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
