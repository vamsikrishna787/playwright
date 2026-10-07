import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, type Suite, type SuiteInput } from './api';

// ---------------------------------------------------------------- status badges

const LABELS: Record<string, [string, string]> = {
  // script status
  none: ['No script', 'neutral'],
  generating: ['Generating', 'info'],
  ready: ['Script ready', 'success'],
  stale: ['Script outdated', 'warning'],
  // job / run status
  queued: ['Queued', 'info'],
  running: ['Running', 'info'],
  succeeded: ['Succeeded', 'success'],
  passed: ['Passed', 'success'],
  failed: ['Failed', 'danger'],
  error: ['Error', 'danger'],
  // suite status
  empty: ['No tests', 'neutral'],
  failing: ['Failing', 'danger'],
  passing: ['Passing', 'success'],
  'not-run': ['Not run', 'neutral'],
};

export function StatusBadge({ status, prefix }: { status?: string | null; prefix?: string }) {
  const [label, tone] = LABELS[status ?? 'none'] ?? [status ?? '-', 'neutral'];
  const spinning = status === 'running' || status === 'generating' || status === 'queued';
  return (
    <span className={`badge badge-${tone}`}>
      {spinning ? <span className="spinner" aria-hidden /> : <span className="dot" aria-hidden />}
      {prefix ? `${prefix} ${label.toLowerCase()}` : label}
    </span>
  );
}

export function ScriptBadge({ status }: { status: string }) {
  if (status === 'failed') {
    return (
      <span className="badge badge-danger">
        <span className="dot" aria-hidden />
        Generation failed
      </span>
    );
  }
  return <StatusBadge status={status} />;
}

// ---------------------------------------------------------------- lighthouse

const LH_LABELS: Record<string, string> = {
  performance: 'Performance',
  accessibility: 'Accessibility',
  'best-practices': 'Best practices',
  seo: 'SEO',
};

export function scoreTone(score: number | null | undefined) {
  if (score == null) return 'neutral';
  if (score >= 90) return 'success';
  if (score >= 50) return 'warning';
  return 'danger';
}

export function ScoreRing({ score, label, size = 72 }: { score: number | null; label: string; size?: number }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const pct = score == null ? 0 : score / 100;
  return (
    <div className={`score score-${scoreTone(score)}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label}: ${score ?? 'n/a'}`}>
        <circle cx={size / 2} cy={size / 2} r={r} className="score-track" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="score-value"
          strokeDasharray={`${c * pct} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle">
          {score ?? '-'}
        </text>
      </svg>
      <span>{label}</span>
    </div>
  );
}

export function LighthouseScores({ scores, size }: { scores: Record<string, number | null>; size?: number }) {
  return (
    <div className="scores">
      {Object.entries(LH_LABELS).map(([key, label]) => (
        <ScoreRing key={key} score={scores[key] ?? null} label={label} size={size} />
      ))}
    </div>
  );
}

export function PerfChip({ scores }: { scores?: Record<string, number | null> | null }) {
  const perf = scores?.performance;
  if (perf == null) return <span className="muted">-</span>;
  return <span className={`chip chip-${scoreTone(perf)}`}>{perf}</span>;
}

// ---------------------------------------------------------------- toasts

interface Toast {
  id: number;
  tone: 'success' | 'danger' | 'info';
  message: string;
}

const ToastContext = createContext<(tone: Toast['tone'], message: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, tone, message }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), tone === 'danger' ? 8000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------- modal + suite dialog

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function SuiteDialog({
  suite,
  onClose,
  onSaved,
}: {
  suite?: Suite;
  onClose: () => void;
  onSaved: (suite: Suite) => void;
}) {
  const [form, setForm] = useState<SuiteInput>({
    name: suite?.name ?? '',
    description: suite?.description ?? '',
    baseUrl: suite?.baseUrl ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onSaved(suite ? await api.updateSuite(suite.id, form) : await api.createSuite(form));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={suite ? 'Edit suite' : 'New test suite'} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          Name
          <input autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Checkout flows" />
        </label>
        <label>
          Base URL <span className="muted">(optional; tests can use relative start paths)</span>
          <input type="url" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://staging.example.com" />
        </label>
        <label>
          Description
          <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </label>
        {error && <div className="alert alert-danger">{error}</div>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : suite ? 'Save' : 'Create suite'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}
