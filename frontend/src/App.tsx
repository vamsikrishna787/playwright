import { Navigate, NavLink, Link, Route, Routes } from 'react-router-dom';
import NewTestPage from './pages/NewTestPage';
import RecordPage from './pages/RecordPage';
import ScriptsListPage from './pages/ScriptsListPage';
import ScriptDetailPage from './pages/ScriptDetailPage';
import RunDetailPage from './pages/RunDetailPage';

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/scripts" className="brand">
          Playwright Test Generator
        </Link>
        <nav className="nav">
          <NavLink to="/scripts">My Scripts</NavLink>
          <NavLink to="/new">New Test</NavLink>
          <NavLink to="/record">Record</NavLink>
        </nav>
      </header>

      <main className="container">
        <Routes>
          <Route path="/" element={<Navigate to="/scripts" replace />} />
          <Route path="/new" element={<NewTestPage />} />
          <Route path="/record" element={<RecordPage />} />
          <Route path="/scripts" element={<ScriptsListPage />} />
          <Route path="/scripts/:id" element={<ScriptDetailPage />} />
          <Route path="/scripts/:id/runs/:runId" element={<RunDetailPage />} />
        </Routes>
      </main>
    </div>
  );
}
