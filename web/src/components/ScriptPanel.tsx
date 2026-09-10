'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AgentAction, DerivedStep, TestCase } from '../types';

const IMPROVE_GOALS = ['stability', 'readability', 'coverage', 'performance'];

/**
 * Monaco reaches for `window` as it loads, so it cannot be server-rendered. The
 * placeholder keeps the panel from collapsing while the editor arrives.
 */
const Editor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => <div className="empty">Loading the editor…</div>,
});

/**
 * The script: the code the agent wrote, what it does in plain English, and the
 * agent calls that change it.
 *
 * Two views over one buffer. The Script view is the file; the Steps view is the
 * agent tier reading that file back as sentences — which after a few refinements
 * is not always what was originally authored, and is the quickest way to see
 * that.
 */
export default function ScriptPanel({
  test,
  suiteName,
  code,
  onCodeChange,
  onSaved,
}: {
  test: TestCase;
  suiteName: string;
  code: string;
  onCodeChange: (code: string) => void;
  onSaved: (test: TestCase) => void;
}) {
  const [view, setView] = useState<'script' | 'steps'>('script');
  const [derived, setDerived] = useState<DerivedStep[] | null>(null);
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [instruction, setInstruction] = useState('');
  const [goal, setGoal] = useState(IMPROVE_GOALS[0]!);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [reply, setReply] = useState('');
  /** Set when an agent returned code that has not been written to disk yet. */
  const [pending, setPending] = useState(false);

  useEffect(() => {
    api
      .agentCatalog()
      .then((body) => setActions(body.actions))
      .catch(() => setActions([]));
  }, []);

  // The plain-English reading is fetched on demand, and re-fetched whenever the
  // buffer changes underneath it, so the two views never disagree.
  useEffect(() => {
    if (view !== 'steps' || !code.trim()) return;
    let cancelled = false;
    api
      .derivedSteps(test.id, code)
      .then((body) => !cancelled && setDerived(body.steps))
      .catch(() => !cancelled && setDerived([]));
    return () => {
      cancelled = true;
    };
  }, [view, code, test.id]);

  const guard = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setError('');
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  const generate = () =>
    guard('generate', async () => {
      const result = await api.generate(test.id, suiteName);
      onCodeChange(result.code);
      setReply(result.reply);
      setPending(false);
      onSaved(result);
    });

  const callAgent = (action: string) =>
    guard(action, async () => {
      const result = await api.runAgent(test.id, action, {
        code,
        instruction: action === 'refine' ? instruction : undefined,
        goal: action === 'improve' ? goal : undefined,
      });
      onCodeChange(result.code);
      setReply(result.reply);
      // Returned unsaved so it can be read before it replaces what is on disk.
      setPending(true);
      if (action === 'refine') setInstruction('');
    });

  const save = () =>
    guard('save', async () => {
      const updated = await api.saveScript(test.id, code);
      setPending(false);
      onSaved(updated);
    });

  const hasCode = code.trim().length > 0;
  const canGenerate = test.steps.length > 0 && Boolean(test.url);

  return (
    <div>
      <div className="page-head">
        <div className="tabs" style={{ marginBottom: 0, border: 'none' }}>
          <button className={view === 'script' ? 'on' : ''} onClick={() => setView('script')}>
            Script view
          </button>
          <button
            className={view === 'steps' ? 'on' : ''}
            onClick={() => setView('steps')}
            disabled={!hasCode}
          >
            Steps view
          </button>
        </div>

        <div className="actions">
          {pending && <span className="small" style={{ color: 'var(--warn)' }}>unsaved agent edit</span>}
          <button onClick={save} disabled={!hasCode || busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save script'}
          </button>
          <button className="primary" onClick={generate} disabled={!canGenerate || busy !== null}>
            {busy === 'generate' ? 'Generating…' : hasCode ? 'Regenerate with AI' : 'Generate with AI'}
          </button>
        </div>
      </div>

      {!canGenerate && (
        <div className="note">
          {test.steps.length === 0
            ? 'Add at least one step before generating — the steps are the instructions.'
            : 'This test has no URL. Set one on the test, or a base URL on the suite.'}
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}
      {reply && !error && <div className="note">{reply}</div>}

      {view === 'script' ? (
        <div className="editor-wrap">
          <Editor
            height="540px"
            language="typescript"
            theme="vs-dark"
            value={code}
            onChange={(next) => {
              onCodeChange(next ?? '');
              setPending(true);
            }}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
              tabSize: 2,
              automaticLayout: true,
            }}
          />
        </div>
      ) : (
        <DerivedSteps steps={derived} />
      )}

      {hasCode && actions.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Ask an agent to change it</h3>
          <p className="muted small" style={{ marginTop: 0 }}>
            Each of these is a separate endpoint on the Python API. Results come back unsaved — read
            them, then press Save script.
          </p>

          {actions.some((action) => action.id === 'refine') && (
            <div className="row" style={{ marginBottom: 12 }}>
              <div>
                <label>Describe a change</label>
                <input
                  value={instruction}
                  placeholder="Also assert the cart badge shows 1"
                  onChange={(event) => setInstruction(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && instruction.trim() && !busy) callAgent('refine');
                  }}
                />
              </div>
              <div className="shrink">
                <button
                  onClick={() => callAgent('refine')}
                  disabled={!instruction.trim() || busy !== null}
                >
                  {busy === 'refine' ? 'Working…' : 'Refine'}
                </button>
              </div>
            </div>
          )}

          <div className="actions">
            {actions
              .filter((action) => action.id !== 'refine')
              .map((action) => (
                <span key={action.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {action.id === 'improve' && (
                    <select
                      value={goal}
                      onChange={(event) => setGoal(event.target.value)}
                      style={{ width: 'auto' }}
                    >
                      {IMPROVE_GOALS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    onClick={() => callAgent(action.id)}
                    disabled={busy !== null}
                    title={action.description}
                  >
                    {busy === action.id ? 'Working…' : action.label}
                  </button>
                </span>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DerivedSteps({ steps }: { steps: DerivedStep[] | null }) {
  if (steps === null) return <div className="empty">Reading the script…</div>;
  if (steps.length === 0) {
    return <div className="empty">Nothing recognisable in the script yet.</div>;
  }

  // Grouped by the test() they belong to: a spec holds the functional journey
  // and the accessibility scan, and reading them as one list is confusing.
  const groups = steps.reduce<Record<string, DerivedStep[]>>((into, step) => {
    const key = step.test || 'Test';
    (into[key] ??= []).push(step);
    return into;
  }, {});

  return (
    <div>
      {Object.entries(groups).map(([title, group]) => (
        <div key={title} style={{ marginBottom: 18 }}>
          <h3>{title}</h3>
          <div className="steps">
            {group.map((step, index) => (
              <div className="step" key={`${title}-${index}`}>
                <div className="num">{index + 1}</div>
                <div className="body">
                  <div>{step.text}</div>
                  {step.title && <div className="expected">step: {step.title}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
