import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import ConflictReview, { conflictId } from '../components/ConflictReview';
import type {
  ConflictChoice,
  ConflictResolution,
  DomainSummary,
  LocatorConflict,
  RecordingSession,
} from '../types';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export default function RecordPage() {
  const navigate = useNavigate();
  const { domainId } = useParams<{ domainId: string }>();
  const [params] = useSearchParams();

  const [domain, setDomain] = useState<DomainSummary | null>(null);
  const [url, setUrl] = useState(params.get('url') ?? '');
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [session, setSession] = useState<RecordingSession | null>(null);
  const [conflicts, setConflicts] = useState<LocatorConflict[] | null>(null);
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({});
  const [starting, setStarting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionId = useRef<string | null>(null);

  const recording = session?.status === 'recording';

  useEffect(() => {
    if (!domainId) return;
    api
      .getDomain(domainId)
      .then((found) => {
        setDomain(found);
        setUrl((current) => current || found.baseUrl);
      })
      .catch((err) => setError(message(err)));
  }, [domainId]);

  // Poll while the browser is open so captured pages appear as the user moves.
  useEffect(() => {
    if (!recording || !sessionId.current) return;
    const timer = window.setTimeout(async () => {
      try {
        setSession(await api.getRecording(sessionId.current!));
      } catch {
        /* keep the last known state; the next tick retries */
      }
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [recording, session]);

  /** Asked for once the pages stop moving — a diff of a live capture is noise. */
  const loadConflicts = useCallback(async (id: string) => {
    try {
      const { conflicts: found } = await api.getConflicts(id);
      setConflicts(found);
      setChoices(Object.fromEntries(found.map((c) => [conflictId(c), 'new' as ConflictChoice])));
    } catch (err) {
      setError(message(err));
    }
  }, []);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const started = await api.startRecording({ url: url.trim(), domainId });
      sessionId.current = started.id;
      setSession(started);
      setConflicts(null);
    } catch (err) {
      setError(message(err));
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    if (!sessionId.current) return;
    try {
      setSession(await api.stopRecording(sessionId.current));
      await loadConflicts(sessionId.current);
    } catch (err) {
      setError(message(err));
    }
  };

  // Closing the browser window ends the session server-side; pick the diff up then too.
  useEffect(() => {
    if (session && !recording && conflicts === null && sessionId.current) {
      loadConflicts(sessionId.current);
    }
  }, [session, recording, conflicts, loadConflicts]);

  const generate = async () => {
    if (!sessionId.current) return;
    setGenerating(true);
    setError(null);

    const resolutions: ConflictResolution[] = (conflicts ?? []).map((conflict) => ({
      pageUrl: conflict.pageUrl,
      key: conflict.key,
      choice: choices[conflictId(conflict)] ?? 'new',
    }));

    try {
      const script = await api.generateFromRecording(sessionId.current, {
        prompt: prompt.trim(),
        name: name.trim() || undefined,
        resolutions,
      });
      navigate(`/scripts/${script.id}`);
    } catch (err) {
      setError(message(err));
      setGenerating(false);
    }
  };

  const reset = () => {
    sessionId.current = null;
    setSession(null);
    setConflicts(null);
    setChoices({});
    setError(null);
  };

  return (
    <>
      <h1>Record a flow{domain ? ` on ${domain.name}` : ''}</h1>
      <p className="subtitle">
        A browser opens on your machine and you walk the flow yourself — log in, dismiss banners,
        go wherever the test needs to reach. Every page you land on is inventoried and saved to
        this site's locator library, so later scripts start from real elements rather than guesses.
      </p>

      {!session && (
        <div className="card">
          <div className="field">
            <label htmlFor="rec-url">Starting URL</label>
            <input
              id="rec-url"
              type="text"
              placeholder="https://www.saucedemo.com/"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          {domain && domain.locatorCount > 0 && (
            <p className="muted" style={{ marginTop: -6 }}>
              {domain.locatorCount} locators already known for this site will be handed to the
              model alongside whatever you record now.
            </p>
          )}
          <button className="primary" onClick={start} disabled={starting || !url.trim()}>
            {starting ? (
              <>
                <span className="spinner" />
                Opening browser…
              </>
            ) : (
              'Start recording'
            )}
          </button>
        </div>
      )}

      {error && (
        <div className="error-box" style={{ marginTop: 16 }}>
          {error}
        </div>
      )}

      {session && (
        <>
          <div className="card">
            <div className="spread">
              <div>
                <span className={`badge ${recording ? 'running' : 'passed'}`}>
                  {recording && <span className="spinner" />}
                  {recording ? 'Recording' : 'Stopped'}
                </span>
                <span className="muted mono" style={{ marginLeft: 12 }}>
                  {session.pages.length} page{session.pages.length === 1 ? '' : 's'} ·{' '}
                  {session.actionCount} action{session.actionCount === 1 ? '' : 's'} captured
                </span>
              </div>
              <div className="row">
                {recording ? (
                  <button onClick={stop}>Stop recording</button>
                ) : (
                  <button onClick={reset}>Start over</button>
                )}
              </div>
            </div>

            {recording && (
              <p className="muted" style={{ marginTop: 14, marginBottom: 0 }}>
                Use the browser window that just opened. Close it, or click Stop, when you have
                reached the end of the flow.
              </p>
            )}
          </div>

          <div className="grid-2" style={{ marginTop: 20 }}>
            <div>
              <h2 style={{ marginTop: 0 }}>Captured pages</h2>
              {session.pages.length === 0 ? (
                <div className="card empty">
                  Nothing captured yet — navigate in the browser window.
                </div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 30 }}>#</th>
                      <th>Page</th>
                      <th style={{ width: 70 }}>Elements</th>
                      <th style={{ width: 70 }}>A11y</th>
                    </tr>
                  </thead>
                  <tbody>
                    {session.pages.map((page, i) => (
                      <tr key={page.url}>
                        <td className="muted mono">{i + 1}</td>
                        <td>
                          <div>{page.title || '(untitled)'}</div>
                          <div className="mono muted" style={{ fontSize: 11 }}>
                            {page.url}
                          </div>
                        </td>
                        <td className="mono">{page.elementCount}</td>
                        <td className="mono">
                          {page.axeCount > 0 ? (
                            <span style={{ color: 'var(--warn)' }}>{page.axeCount}</span>
                          ) : (
                            <span className="muted">0</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div>
              <h2 style={{ marginTop: 0 }}>Your actions</h2>
              {session.actions.length === 0 ? (
                <div className="card empty">Click and type in the browser to record steps.</div>
              ) : (
                <ol className="action-list">
                  {session.actions.map((action, i) => (
                    <li key={`${i}-${action.locator}`}>
                      <span className={`action-kind ${action.type}`}>{action.type}</span>
                      <span className="mono">{action.locator}</span>
                      {action.value && <span className="muted"> → {action.value}</span>}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>

          {conflicts !== null && conflicts.length > 0 && (
            <>
              <h2>
                {conflicts.length} locator{conflicts.length === 1 ? '' : 's'} changed
              </h2>
              <p className="subtitle">
                These elements are already in this site's library, but the expression that
                identifies them came out different this time. Pick what to keep — your answer is
                saved to the library and used for this generation.
              </p>
              <ConflictReview
                conflicts={conflicts}
                choices={choices}
                onChange={(id, choice) => setChoices((current) => ({ ...current, [id]: choice }))}
              />
            </>
          )}

          {conflicts !== null && conflicts.length === 0 && session.pages.length > 0 && (
            <p className="muted" style={{ marginTop: 18 }}>
              No locator changes — everything recorded matches what the library already had.
            </p>
          )}

          <h2>What should the test verify?</h2>
          <div className="card">
            <div className="field">
              <label htmlFor="rec-prompt">
                Scenario and test data{' '}
                <span className="hint">— describe the flow you just walked</span>
              </label>
              <textarea
                id="rec-prompt"
                placeholder="Log in as standard_user / secret_sauce, then verify the products page lists items with Add to cart buttons."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="rec-name">
                Name <span className="hint">— optional</span>
              </label>
              <input
                id="rec-name"
                type="text"
                placeholder="Login and view products"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <button
              className="primary"
              onClick={generate}
              disabled={generating || !prompt.trim() || session.pages.length === 0}
            >
              {generating ? (
                <>
                  <span className="spinner" />
                  Generating from {session.pages.length} pages…
                </>
              ) : (
                'Generate test'
              )}
            </button>
            <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
              {recording
                ? 'Generating will stop the recording first. '
                : ''}
              An accessibility check against WCAG 2.1 A/AA is always included.
            </p>
          </div>
        </>
      )}
    </>
  );
}
