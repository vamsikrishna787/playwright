import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { DomainLibrary } from '../types';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export default function GenerateWithAiPage() {
  const navigate = useNavigate();
  const { domainId } = useParams<{ domainId: string }>();

  const [library, setLibrary] = useState<DomainLibrary | null>(null);
  const [url, setUrl] = useState('');
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!domainId) return;
    api
      .getLibrary(domainId)
      .then((found) => {
        setLibrary(found);
        // Default to the page with the most known locators: it is the one the
        // model can write about with the least guessing.
        const richest = [...found.pages].sort((a, b) => b.locators.length - a.locators.length)[0];
        setUrl(richest?.url ?? found.domain.baseUrl);
      })
      .catch((err) => setError(message(err)));
  }, [domainId]);

  const generate = async () => {
    if (!domainId) return;
    setGenerating(true);
    setError(null);
    try {
      const script = await api.generateWithAi(domainId, {
        prompt: prompt.trim(),
        url: url.trim() || undefined,
        name: name.trim() || undefined,
      });
      navigate(`/scripts/${script.id}`);
    } catch (err) {
      setError(message(err));
      setGenerating(false);
    }
  };

  const known = library?.pages ?? [];
  const unrecorded = url.trim() !== '' && !known.some((page) => url.trim().startsWith(page.url));

  return (
    <>
      <h1>Generate with AI{library ? ` · ${library.domain.name}` : ''}</h1>
      <p className="subtitle">
        Describe the test in plain English. It is written against the locators already recorded for
        this site — no browser opens, and no element is invented.
      </p>

      {error && (
        <div className="error-box" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <div className="field">
            <label htmlFor="ai-url">Page the test starts on</label>
            {known.length > 0 ? (
              <select
                id="ai-url"
                className="select"
                value={known.some((page) => page.url === url) ? url : '__custom'}
                onChange={(e) => e.target.value !== '__custom' && setUrl(e.target.value)}
              >
                {known.map((page) => (
                  <option key={page.url} value={page.url}>
                    {page.url} — {page.locators.length} locators
                  </option>
                ))}
                <option value="__custom">Another URL…</option>
              </select>
            ) : null}
            <input
              type="text"
              placeholder="https://www.saucedemo.com/"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              style={{ marginTop: known.length > 0 ? 8 : 0 }}
            />
            {unrecorded && (
              <p className="hint" style={{ marginTop: 6 }}>
                This page has not been recorded. It will be crawled once so the test has real
                elements to work from.
              </p>
            )}
          </div>

          <div className="field">
            <label htmlFor="ai-prompt">
              What should the test do?{' '}
              <span className="hint">— include any credentials or data it needs</span>
            </label>
            <textarea
              id="ai-prompt"
              placeholder={
                'Log in with standard_user / secret_sauce, add the first product to the cart, and check the cart badge shows 1.'
              }
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="ai-name">
              Name <span className="hint">— optional</span>
            </label>
            <input
              id="ai-name"
              type="text"
              placeholder="Add to cart"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <button className="primary" onClick={generate} disabled={generating || !prompt.trim()}>
            {generating ? (
              <>
                <span className="spinner" />
                Generating…
              </>
            ) : (
              'Generate test'
            )}
          </button>
          <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
            An accessibility check against WCAG 2.1 A/AA is always included.
          </p>
        </div>

        <div>
          <h2 style={{ marginTop: 0 }}>What the model will see</h2>
          {library === null && <p className="muted">Loading…</p>}

          {library && known.length === 0 && (
            <div className="card empty">
              <p>No locators recorded for this site yet.</p>
              <Link to={`/domains/${domainId}/record`}>Record a flow first</Link>
            </div>
          )}

          {known.map((page) => (
            <div key={page.url} className="card library-page">
              <div className="spread">
                <div className="mono" style={{ wordBreak: 'break-all' }}>
                  {page.url}
                </div>
                <span className="muted mono">{page.locators.length}</span>
              </div>
              <ul className="locator-preview">
                {page.locators.slice(0, 6).map((entry) => (
                  <li key={entry.key}>
                    <span className="mono">{entry.name || entry.key}</span>
                    {entry.verified && <span className="badge verified">verified</span>}
                  </li>
                ))}
                {page.locators.length > 6 && (
                  <li className="muted">+{page.locators.length - 6} more</li>
                )}
              </ul>
            </div>
          ))}

          {known.length > 0 && (
            <Link to={`/domains/${domainId}/locators`}>Open the full locator library</Link>
          )}
        </div>
      </div>
    </>
  );
}
