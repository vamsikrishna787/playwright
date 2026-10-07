import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type DataPoint, type RunOptions, type TestCase, type TestDefinition } from './api';
import { EmptyState, LighthouseScores, PerfChip, ScriptBadge, StatusBadge, useToast } from './components';
import { formatBytes, formatDateTime, formatDuration, isActive, navigate, notifySuitesChanged, paths, runInProgress, timeAgo, usePolledResource } from './lib';
import { RunOptionsPicker } from './SuitePage';

const EMPTY: TestDefinition = { name: '', description: '', startUrl: '', expectedResult: '', steps: [''], dataPoints: [] };

function toDefinition(t: TestCase): TestDefinition {
  return {
    name: t.name,
    description: t.description ?? '',
    startUrl: t.startUrl ?? '',
    expectedResult: t.expectedResult ?? '',
    steps: t.steps.length ? t.steps : [''],
    dataPoints: t.dataPoints,
  };
}

function normalize(d: TestDefinition): TestDefinition {
  return {
    ...d,
    name: d.name.trim(),
    steps: d.steps.map((s) => s.trim()).filter(Boolean),
    dataPoints: d.dataPoints.filter((p) => p.key.trim()).map((p) => ({ key: p.key.trim(), value: p.value })),
  };
}

const testIsBusy = (t: TestCase) => t.scriptStatus === 'generating' || runInProgress(t.lastRun);

type Tab = 'script' | 'generation' | 'runs';

export function TestPage({ suiteId, testId, runId }: { suiteId: string; testId?: string; runId?: string }) {
  const toast = useToast();
  const isNew = !testId;
  const test = usePolledResource(
    () => (testId ? api.getTest(suiteId, testId) : Promise.resolve(null)),
    `${suiteId}/${testId ?? 'new'}`,
    (t) => !!t && testIsBusy(t),
  );
  const suiteForNew = usePolledResource(() => (isNew ? api.getSuite(suiteId) : Promise.resolve(null)), `${suiteId}/${isNew}`);
  const suite = test.data?.suite ?? suiteForNew.data;

  const [form, setForm] = useState<TestDefinition>(EMPTY);
  const [savedVersion, setSavedVersion] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(runId ? 'runs' : 'script');
  const [runOptions, setRunOptions] = useState<RunOptions>({ lighthouse: true, lighthousePreset: 'desktop' });

  const saved = test.data ? toDefinition(test.data) : EMPTY;
  const dirty = JSON.stringify(normalize(form)) !== JSON.stringify(normalize(saved));

  // Load the form when the test loads or is saved elsewhere, without clobbering unsaved edits during polling.
  useEffect(() => {
    if (!test.data) {
      if (isNew) setForm(EMPTY);
      return;
    }
    if (test.data.updatedAt !== savedVersion) {
      setForm(toDefinition(test.data));
      setSavedVersion(test.data.updatedAt);
    }
  }, [test.data, isNew, savedVersion]);

  useEffect(() => {
    if (runId) setTab('runs');
  }, [runId]);

  const save = async () => {
    setSaving(true);
    try {
      const def = normalize(form);
      if (isNew) {
        const created = await api.createTest(suiteId, def);
        toast('success', 'Test saved. Generate a script when you are ready.');
        notifySuitesChanged();
        navigate(paths.test(suiteId, created.id));
      } else {
        await api.updateTest(suiteId, testId!, def);
        toast('success', 'Test saved');
        test.refresh();
        notifySuitesChanged();
      }
    } catch (err) {
      toast('danger', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const act = async (label: string, fn: () => Promise<unknown>, success: string, nextTab?: Tab) => {
    setBusy(label);
    try {
      await fn();
      toast('success', success);
      if (nextTab) setTab(nextTab);
      test.refresh();
      notifySuitesChanged();
    } catch (err) {
      toast('danger', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!test.data || !confirm(`Delete test "${test.data.name}" with its script and run reports?`)) return;
    await act('delete', () => api.deleteTest(suiteId, testId!), 'Test deleted');
    navigate(paths.suite(suiteId));
  };

  if (test.error) return <div className="page"><div className="alert alert-danger">{test.error}</div></div>;
  if (!isNew && !test.data) return <div className="page muted">Loading test…</div>;

  const t = test.data;
  const hasScript = t?.scriptStatus === 'ready' || t?.scriptStatus === 'stale';
  const generating = t?.scriptStatus === 'generating';
  const running = isActive(t?.lastRun?.status);

  return (
    <div className="page">
      <nav className="crumbs">
        <a href={paths.home()}>Suites</a> / <a href={paths.suite(suiteId)}>{suite?.name ?? '…'}</a> / <span>{isNew ? 'New test' : t?.name}</span>
      </nav>

      <header className="page-header">
        <div>
          <h1>{isNew ? 'New test case' : t?.name}</h1>
          {t && (
            <div className="badges">
              <ScriptBadge status={t.scriptStatus} />
              {t.lastRun && <StatusBadge status={t.lastRun.status} prefix="Last run" />}
            </div>
          )}
        </div>
        <div className="actions">
          {!isNew && (
            <button className="btn btn-danger-ghost" onClick={remove} disabled={!!busy}>
              Delete
            </button>
          )}
          <button className="btn" onClick={save} disabled={saving || (!dirty && !isNew)}>
            {saving ? 'Saving…' : dirty || isNew ? 'Save' : 'Saved'}
          </button>
        </div>
      </header>

      {t && (
        <div className="action-bar">
          <div className="action-group">
            <div>
              <strong>1. Generate script</strong>
              <p className="muted small">
                {dirty
                  ? 'Save your changes first.'
                  : generating
                    ? 'The AI agent is performing the steps in a browser and verifying the script…'
                    : t.scriptStatus === 'stale'
                      ? 'Steps changed since the script was generated.'
                      : hasScript
                        ? `Verified ${timeAgo(t.script?.generatedAt)}.`
                        : 'AI performs the steps with Playwright MCP and keeps a script only if it passes.'}
              </p>
            </div>
            <button
              className={`btn ${hasScript && t.scriptStatus !== 'stale' ? '' : 'btn-primary'}`}
              disabled={dirty || generating || !!busy}
              onClick={() => act('generate', () => api.generate(suiteId, t.id), 'Script generation started', 'generation')}
            >
              {generating ? 'Generating…' : hasScript ? 'Regenerate' : 'Generate script'}
            </button>
          </div>
          <div className="action-group">
            <div>
              <strong>2. Run test</strong>
              <p className="muted small">
                {hasScript ? 'Runs the verified script in Lambda with video, trace and Lighthouse.' : 'Available once a script has been generated.'}
              </p>
              <RunOptionsPicker value={runOptions} onChange={setRunOptions} />
            </div>
            <button
              className="btn btn-primary"
              disabled={!hasScript || running || dirty || !!busy}
              title={dirty ? 'Save your changes first' : undefined}
              onClick={() => act('run', () => api.runTest(suiteId, t.id, runOptions), 'Run started', 'runs')}
            >
              {running ? 'Running…' : 'Run test'}
            </button>
          </div>
        </div>
      )}

      <div className={isNew ? '' : 'split'}>
        <section className="card editor">
          <TestEditor value={form} onChange={setForm} baseUrl={suite?.baseUrl} resolved={t?.resolvedStartUrl} />
        </section>

        {t && (
          <section className="card panel">
            <div className="tabs" role="tablist">
              <TabButton current={tab} value="script" onSelect={setTab}>
                Script
              </TabButton>
              <TabButton current={tab} value="generation" onSelect={setTab}>
                AI generation {generating && <span className="spinner" aria-hidden />}
              </TabButton>
              <TabButton current={tab} value="runs" onSelect={setTab}>
                Runs ({t.runCount}) {running && <span className="spinner" aria-hidden />}
              </TabButton>
            </div>
            {tab === 'script' && <ScriptPanel test={t} />}
            {tab === 'generation' && <GenerationPanel test={t} />}
            {tab === 'runs' && <RunsPanel test={t} runId={runId} />}
          </section>
        )}
      </div>
    </div>
  );
}

function TabButton({ current, value, onSelect, children }: { current: Tab; value: Tab; onSelect: (t: Tab) => void; children: ReactNode }) {
  return (
    <button role="tab" aria-selected={current === value} className={`tab ${current === value ? 'active' : ''}`} onClick={() => onSelect(value)}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- editor

function TestEditor({
  value,
  onChange,
  baseUrl,
  resolved,
}: {
  value: TestDefinition;
  onChange: (v: TestDefinition) => void;
  baseUrl?: string;
  resolved?: string;
}) {
  const set = <K extends keyof TestDefinition>(key: K, v: TestDefinition[K]) => onChange({ ...value, [key]: v });

  const setStep = (i: number, text: string) => set('steps', value.steps.map((s, j) => (j === i ? text : s)));
  const addStep = (after = value.steps.length - 1) =>
    set('steps', [...value.steps.slice(0, after + 1), '', ...value.steps.slice(after + 1)]);
  const removeStep = (i: number) => set('steps', value.steps.length > 1 ? value.steps.filter((_, j) => j !== i) : ['']);
  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.steps.length) return;
    const steps = [...value.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    set('steps', steps);
  };

  const setPoint = (i: number, patch: Partial<DataPoint>) =>
    set('dataPoints', value.dataPoints.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <div className="form">
      <label>
        Test name
        <input value={value.name} onChange={(e) => set('name', e.target.value)} placeholder="User can log in with valid credentials" />
      </label>
      <label>
        Description
        <textarea rows={2} value={value.description} onChange={(e) => set('description', e.target.value)} placeholder="What this test proves" />
      </label>
      <label>
        Start URL
        <input
          value={value.startUrl}
          onChange={(e) => set('startUrl', e.target.value)}
          placeholder={baseUrl ? `/login  (relative to ${baseUrl})` : 'https://example.com/login'}
        />
        {resolved && resolved !== value.startUrl && <span className="muted small">Resolves to {resolved}</span>}
      </label>

      <fieldset>
        <legend>Data points</legend>
        <p className="muted small">
          Values the test uses, such as credentials or search terms. Refer to them in steps by key, for example <code>{'{{username}}'}</code>. Scripts read
          them at run time, so changing a value doesn't need a new script.
        </p>
        {value.dataPoints.map((p, i) => (
          <div className="kv-row" key={i}>
            <input aria-label="Key" placeholder="key" value={p.key} onChange={(e) => setPoint(i, { key: e.target.value.replace(/[^A-Za-z0-9_]/g, '_') })} />
            <input aria-label="Value" placeholder="value" value={p.value} onChange={(e) => setPoint(i, { value: e.target.value })} />
            <button type="button" className="icon-btn" aria-label="Remove data point" onClick={() => set('dataPoints', value.dataPoints.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={() => set('dataPoints', [...value.dataPoints, { key: '', value: '' }])}>
          + Add data point
        </button>
      </fieldset>

      <fieldset>
        <legend>Steps</legend>
        <ol className="steps">
          {value.steps.map((step, i) => (
            <li key={i}>
              <span className="step-num">{i + 1}</span>
              <textarea
                rows={1}
                value={step}
                placeholder={i === 0 ? 'Click "Sign in"' : 'Next step…'}
                onChange={(e) => setStep(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    addStep(i);
                    setTimeout(() => {
                      const items = document.querySelectorAll<HTMLTextAreaElement>('.steps textarea');
                      items[i + 1]?.focus();
                    });
                  }
                }}
              />
              <div className="step-tools">
                <button type="button" className="icon-btn" aria-label="Move up" onClick={() => moveStep(i, -1)} disabled={i === 0}>
                  ↑
                </button>
                <button type="button" className="icon-btn" aria-label="Move down" onClick={() => moveStep(i, 1)} disabled={i === value.steps.length - 1}>
                  ↓
                </button>
                <button type="button" className="icon-btn" aria-label="Remove step" onClick={() => removeStep(i)}>
                  ×
                </button>
              </div>
            </li>
          ))}
        </ol>
        <button type="button" className="btn btn-sm" onClick={() => addStep()}>
          + Add step
        </button>
      </fieldset>

      <label>
        Expected result
        <textarea
          rows={3}
          value={value.expectedResult}
          onChange={(e) => set('expectedResult', e.target.value)}
          placeholder='The dashboard shows "Welcome back, {{username}}"'
        />
      </label>
    </div>
  );
}

// ---------------------------------------------------------------- script

function ScriptPanel({ test }: { test: TestCase }) {
  const script = usePolledResource(
    () => api.getScript(test.suiteId, test.id).catch(() => null),
    `${test.id}/${test.script?.generatedAt ?? ''}/${test.generation?.status ?? ''}`,
  );
  const [copied, setCopied] = useState(false);

  if (script.loading) return <div className="muted pad">Loading script…</div>;
  const data = script.data;
  if (!data) {
    return (
      <EmptyState title="No script yet">
        <p className="muted">Save the test, then click Generate script. The AI agent records the steps in a real browser and saves the script only if it passes.</p>
      </EmptyState>
    );
  }
  const code = data.code ?? data.draft ?? '';
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="panel-body">
      {test.scriptStatus === 'stale' && (
        <div className="alert alert-warning">The test definition changed since this script was generated. Regenerate to pick up the new steps.</div>
      )}
      {!data.code && data.draft && (
        <div className="alert alert-danger">Generation did not produce a passing script. This is the last unverified draft, kept for reference.</div>
      )}
      {data.meta && (
        <dl className="meta">
          <div>
            <dt>Verified</dt>
            <dd>{formatDateTime(data.meta.generatedAt)}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{data.meta.model}</dd>
          </div>
          <div>
            <dt>Attempts</dt>
            <dd>{data.meta.submissions}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>
              {(data.meta.usage.input_tokens + data.meta.usage.cache_read_input_tokens + data.meta.usage.cache_creation_input_tokens).toLocaleString()} in /{' '}
              {data.meta.usage.output_tokens.toLocaleString()} out
            </dd>
          </div>
        </dl>
      )}
      {data.meta?.summary && <p className="muted">{data.meta.summary}</p>}
      <div className="code-toolbar">
        <span className="muted small">{data.code ? 'script.spec.ts' : 'draft.spec.ts'}</span>
        <div>
          <button className="btn btn-sm" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          {data.downloadUrl && (
            <a className="btn btn-sm" href={data.downloadUrl}>
              Download
            </a>
          )}
        </div>
      </div>
      <pre className="code">
        {code.split('\n').map((line, i) => (
          <div key={i}>
            <span className="ln">{i + 1}</span>
            {line || ' '}
          </div>
        ))}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------- generation log

const KIND_ICONS: Record<string, string> = {
  info: 'ℹ',
  model: '✦',
  tool: '▸',
  'tool-error': '!',
  verify: '⟳',
  'verify-failed': '✗',
  success: '✓',
  error: '✗',
};

function GenerationPanel({ test }: { test: TestCase }) {
  const job = usePolledResource(
    () => api.getGeneration(test.suiteId, test.id).catch(() => null),
    `${test.id}/${test.generation?.jobId ?? ''}`,
    (j) => !!j && isActive(j.status),
    2500,
  );
  const [expanded, setExpanded] = useState<number | null>(null);

  if (job.loading) return <div className="muted pad">Loading…</div>;
  const j = job.data;
  if (!j) return <EmptyState title="No generation yet"><p className="muted">Click Generate script to start the AI agent.</p></EmptyState>;
  const usage = j.usage;

  return (
    <div className="panel-body">
      <dl className="meta">
        <div>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={j.status} />
          </dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{formatDateTime(j.startedAt ?? j.queuedAt)}</dd>
        </div>
        {j.model && (
          <div>
            <dt>Model</dt>
            <dd>{j.model}</dd>
          </div>
        )}
        {usage && (
          <div>
            <dt>Tokens</dt>
            <dd>
              {(usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens).toLocaleString()} in / {usage.output_tokens.toLocaleString()} out
            </dd>
          </div>
        )}
      </dl>
      {j.error && <div className="alert alert-danger pre">{j.error}</div>}
      <ol className="log">
        {j.log.map((entry, i) => (
          <li key={i} className={`log-${entry.kind}`}>
            <span className="log-icon" aria-hidden>
              {KIND_ICONS[entry.kind] ?? '•'}
            </span>
            <div className="log-body">
              <div className="log-message">{entry.message}</div>
              {entry.detail && (
                <>
                  <button className="link-btn small" onClick={() => setExpanded(expanded === i ? null : i)}>
                    {expanded === i ? 'Hide details' : 'Show details'}
                  </button>
                  {expanded === i && <pre className="log-detail">{entry.detail}</pre>}
                </>
              )}
            </div>
            <time className="muted small">{new Date(entry.t).toLocaleTimeString()}</time>
          </li>
        ))}
        {isActive(j.status) && (
          <li className="log-pending">
            <span className="spinner" aria-hidden /> Working…
          </li>
        )}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------- runs

function RunsPanel({ test, runId }: { test: TestCase; runId?: string }) {
  const runs = test.runs ?? [];
  const selected = runId ?? runs[0]?.runId;
  if (!runs.length) {
    return (
      <EmptyState title="No runs yet">
        <p className="muted">Runs use the verified script and record a video, a Playwright trace and an optional Lighthouse audit.</p>
      </EmptyState>
    );
  }
  return (
    <div className="panel-body">
      <div className="run-list">
        {runs.map((r) => (
          <a key={r.runId} href={paths.run(test.suiteId, test.id, r.runId)} className={`run-item ${r.runId === selected ? 'active' : ''}`}>
            <StatusBadge status={r.status} />
            <span>{timeAgo(r.finishedAt ?? r.queuedAt)}</span>
            <span className="muted">{formatDuration(r.durationMs)}</span>
            <PerfChip scores={r.lighthouseScores} />
          </a>
        ))}
      </div>
      {selected && <RunDetail suiteId={test.suiteId} testId={test.id} runId={selected} />}
    </div>
  );
}

function RunDetail({ suiteId, testId, runId }: { suiteId: string; testId: string; runId: string }) {
  const run = usePolledResource(
    () => api.getRun(suiteId, testId, runId),
    runId,
    runInProgress,
  );
  const video = useMemo(() => run.data?.artifacts?.find((a) => a.name === 'video.webm'), [run.data]);

  if (run.error) return <div className="alert alert-danger">{run.error}</div>;
  if (!run.data) return <div className="muted pad">Loading run…</div>;
  const r = run.data;
  const steps = r.tests?.[0]?.steps ?? [];

  return (
    <div className="run-detail">
      <dl className="meta">
        <div>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={r.status} />
          </dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{formatDateTime(r.startedAt ?? r.queuedAt)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(r.durationMs)}</dd>
        </div>
        <div>
          <dt>Trigger</dt>
          <dd>{r.trigger === 'suite' ? 'Suite run' : 'Manual'}</dd>
        </div>
      </dl>

      {r.error && <div className="alert alert-danger pre">{r.error}</div>}

      {video ? (
        <figure className="video-block">
          <video className="video" controls preload="metadata" src={video.viewUrl}>
            Your browser cannot play WebM video. <a href={video.downloadUrl}>Download it</a>.
          </video>
          <figcaption>
            <span className="muted small">Recording of this run · {formatBytes(video.size)}</span>
            <a className="btn btn-sm" href={video.downloadUrl}>
              Download video
            </a>
          </figcaption>
        </figure>
      ) : (
        runInProgress(r) && <div className="video-placeholder muted">The video recording appears here when the run finishes.</div>
      )}

      {steps.length > 0 && (
        <ol className="step-results">
          {steps.map((s, i) => (
            <li key={i} className={s.error ? 'failed' : 'passed'}>
              <span aria-hidden>{s.error ? '✗' : '✓'}</span>
              <span>{s.title}</span>
              <span className="muted small">{formatDuration(s.durationMs)}</span>
            </li>
          ))}
        </ol>
      )}

      {r.lighthouse && (
        <div className="lighthouse">
          <h3>
            Lighthouse <span className="muted small">({r.lighthousePreset})</span>
          </h3>
          {r.lighthouseScores ? (
            <LighthouseScores scores={r.lighthouseScores} />
          ) : r.lighthouseError ? (
            <div className="alert alert-warning pre">{r.lighthouseError}</div>
          ) : (
            <div className="muted">
              <span className="spinner" aria-hidden /> Waiting for the audit…
            </div>
          )}
        </div>
      )}

      {r.artifacts && r.artifacts.length > 0 && (
        <div>
          <h3>Reports and artifacts</h3>
          <ul className="artifacts">
            {r.artifacts.map((a) => (
              <li key={a.name}>
                <span>{a.label}</span>
                <span className="muted small">{formatBytes(a.size)}</span>
                {(a.name === 'lighthouse.html' || a.name === 'screenshot.png') && (
                  <a className="btn btn-sm" href={a.viewUrl} target="_blank" rel="noreferrer">
                    Open
                  </a>
                )}
                {a.name === 'trace.zip' && (
                  <a className="btn btn-sm" href="https://trace.playwright.dev" target="_blank" rel="noreferrer" title="Download the trace, then drop it into the trace viewer">
                    Trace viewer
                  </a>
                )}
                <a className="btn btn-sm btn-primary" href={a.downloadUrl}>
                  Download
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
