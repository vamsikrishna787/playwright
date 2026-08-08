import { Navigate, NavLink, Link, Route, Routes } from 'react-router-dom';
import GenerateWithAiPage from './pages/GenerateWithAiPage';
import LocatorLibraryPage from './pages/LocatorLibraryPage';
import RecordPage from './pages/RecordPage';
import RunDetailPage from './pages/RunDetailPage';
import ScriptDetailPage from './pages/ScriptDetailPage';
import ScriptsListPage from './pages/ScriptsListPage';

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/scripts" className="brand">
          Playwright Test Generator
        </Link>
        <nav className="nav">
          <NavLink to="/scripts">My Scripts</NavLink>
        </nav>
      </header>

      <main className="container">
        <Routes>
          <Route path="/" element={<Navigate to="/scripts" replace />} />
          <Route path="/scripts" element={<ScriptsListPage />} />
          <Route path="/scripts/:id" element={<ScriptDetailPage />} />
          <Route path="/scripts/:id/runs/:runId" element={<RunDetailPage />} />
          {/* Adding a script always happens inside a site, which is what keeps
              one locator library per site meaningful. */}
          <Route path="/domains/:domainId/record" element={<RecordPage />} />
          <Route path="/domains/:domainId/generate" element={<GenerateWithAiPage />} />
          <Route path="/domains/:domainId/locators" element={<LocatorLibraryPage />} />
          <Route path="*" element={<Navigate to="/scripts" replace />} />
        </Routes>
      </main>
    </div>
  );
}
