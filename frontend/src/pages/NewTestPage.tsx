import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import CodeEditor from '../components/CodeEditor';
import type { ScriptRecord } from '../types';

export default function NewTestPage() {
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(ScriptRecord & { code: string }) | null>(null);
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    setResult(null);
    try {
      const script = await api.generate({ url: url.trim(), prompt: prompt.trim(), name: name.trim() || undefined });
      setResult(script);
      setCode(script.code);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const saveAndOpen = async () => {
    if (!result) return;
    setSaving(true);
    try {
      if (code !== result.code) await api.updateScript(result.id, { code });
      navigate(`/scripts/${result.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <>
      <h1>New Test</h1>
      <p className="subtitle">
        Describe the scenario in plain English. The page is inspected live, then a Playwright test is
        generated from its real structure.
      </p>

      <div className="card">
        <div className="field">
          <label htmlFor="url">Site URL</label>
          <input
            id="url"
            type="text"
            placeholder="https://example.com/login"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="prompt">
            Scenario and test data <span className="hint">— include any credentials or inputs the test needs</span>
          </label>
          <textarea
            id="prompt"
            placeholder={
              'Log in with username "standard_user" and password "secret_sauce", then verify the products page appears.'
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="name">
            Name <span className="hint">— optional, generated automatically if left blank</span>
          </label>
          <input
            id="name"
            type="text"
            placeholder="Login smoke test"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <button
          className="primary"
          onClick={generate}
          disabled={generating || !url.trim() || !prompt.trim()}
        >
          {generating ? <><span className="spinner" />Inspecting page and generating…</> : 'Generate test'}
        </button>
      </div>

      {error && (
        <>
          <h2>Generation failed</h2>
          <div className="error-box">{error}</div>
        </>
      )}

      {result && (
        <>
          <div className="spread" style={{ marginTop: 28 }}>
            <h2 style={{ margin: 0 }}>{result.name}</h2>
            <button className="primary" onClick={saveAndOpen} disabled={saving}>
              {saving ? 'Saving…' : 'Save and open'}
            </button>
          </div>
          <p className="muted" style={{ marginTop: 4 }}>
            Already saved to your scripts. Edit below if you want to adjust it before running.
          </p>
          <CodeEditor value={code} onChange={setCode} />
        </>
      )}
    </>
  );
}
