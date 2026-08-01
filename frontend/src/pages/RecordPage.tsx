import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { RecordingSession } from '../types';

export default function RecordPage() {
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [session, setSession] = useState<RecordingSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionId = useRef<string | null>(null);

  const recording = session?.status === 'recording';

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

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const started = await api.startRecording(url.trim());
      sessionId.current = started.id;
      setSession(started);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    if (!sessionId.current) return;
    try {
      setSession(await api.stopRecording(sessionId.current));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const generate = async () => {
    if (!sessionId.current) return;
    setGenerating(true);
    setError(null);
    try {
      const script = await api.generateFromRecording(sessionId.current, {
        prompt: prompt.trim(),
        name: name.trim() || undefined,
      });
      navigate(`/scripts/${script.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setGenerating(false);
    }
  };

  const reset = () => {
    sessionId.current = null;
    setSession(null);
    setError(null);
  };

  return (
    <>
      <h1>Record a flow</h1>
      <p className="subtitle">
        A browser opens on your machine and you walk the flow yourself — log in, dismiss
        banners, go wherever the test needs to reach. Every page you land on is inventoried,
        so locators on later pages are observed rather than guessed.
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
                  {session.pages.length} page{session.pages.length === 1 ? '' : 's'} captured
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
                Use the browser window that just opened. Close it, or click Stop, when
                you have reached the end of the flow.
              </p>
            )}
          </div>

          <h2>Captured pages</h2>
          {session.pages.length === 0 ? (
            <div className="card empty">Nothing captured yet — navigate in the browser window.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th>Page</th>
                  <th>Elements</th>
                  <th>A11y issues</th>
                </tr>
              </thead>
              <tbody>
                {session.pages.map((page, i) => (
                  <tr key={page.url}>
                    <td className="muted mono">{i + 1}</td>
                    <td>
                      <div>{page.title || '(untitled)'}</div>
                      <div className="mono muted" style={{ fontSize: 12 }}>
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
            {recording && (
              <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
                Generating will stop the recording first.
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}
