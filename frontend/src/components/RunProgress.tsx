import { api } from '../api/client';
import type { Run } from '../types';
import LighthousePanel from './LighthousePanel';
import { StatusBadge, formatDuration } from './StatusBadge';

/**
 * A run as it happens: every authored step, in order, lighting up as the runner
 * reaches it, and stopping visibly at the one that broke.
 *
 * Steps the agent wrote that nobody authored - setup, the accessibility scan -
 * are shown too, but dashed and unnumbered, so "step 3 failed" always means the
 * third step in the user's own list.
 */
export default function RunProgress({ run }: { run: Run }) {
  const authored = run.steps.filter((step) => step.stepId !== null);
  const extra = run.steps.filter((step) => step.stepId === null);

  const reached = authored.filter((step) => step.status === 'passed').length;
  const broke = authored.find((step) => step.status === 'failed');

  return (
    <div>
      <div className="page-head" style={{ marginBottom: 14 }}>
        <div>
          <h2 style={{ marginBottom: 4 }}>
            <StatusBadge status={run.status} />{' '}
            <span className="muted small" style={{ fontWeight: 400 }}>
              {formatDuration(run.durationMs)}
            </span>
          </h2>
          {authored.length > 0 && (
            <p className="muted small" style={{ margin: 0 }}>
              {broke
                ? `Passed ${reached} of ${authored.length} steps, then failed at step ${broke.index}.`
                : `Passed ${reached} of ${authored.length} steps.`}
            </p>
          )}
        </div>
        <div className="actions">
          {run.reportPath && (
            <a href={api.reportUrl(run.id)} target="_blank" rel="noreferrer">
              <button>Playwright report</button>
            </a>
          )}
        </div>
      </div>

      {run.error && <div className="error-banner mono">{run.error}</div>}

      {run.tests.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Tests in this spec</h3>
          {run.tests.map((test) => (
            <div
              key={test.title}
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                padding: '6px 0',
                borderTop: '1px solid var(--border)',
              }}
            >
              <StatusBadge status={test.status === 'running' ? 'running' : (test.status as never)} />
              <span style={{ flex: 1 }}>
                {test.title}
                {test.accessibility && (
                  <span className="small muted" style={{ marginLeft: 8 }}>
                    accessibility
                  </span>
                )}
              </span>
              <span className="small muted">{formatDuration(test.durationMs)}</span>
            </div>
          ))}
        </div>
      )}

      <h3>Steps</h3>
      <div className="steps">
        {authored.map((step) => (
          <div className={`step ${step.status}`} key={step.stepId ?? step.index}>
            <div className="num">{step.index}</div>
            <div className="body">
              <div>{step.title}</div>
              {step.durationMs > 0 && (
                <div className="expected">{formatDuration(step.durationMs)}</div>
              )}
              {step.error && <div className="step-error">{step.error}</div>}
            </div>
          </div>
        ))}

        {extra.map((step, index) => (
          <div className={`step agent-step ${step.status}`} key={`extra-${index}`}>
            <div className="num">·</div>
            <div className="body">
              <div>{step.title}</div>
              <div className="expected">
                added by the agent{step.test ? ` · ${step.test}` : ''}
                {step.durationMs > 0 ? ` · ${formatDuration(step.durationMs)}` : ''}
              </div>
              {step.error && <div className="step-error">{step.error}</div>}
            </div>
          </div>
        ))}
      </div>

      {run.videoPath && (
        <div style={{ marginTop: 18 }}>
          <h3>Recording</h3>
          {/* Keyed on the run so switching runs reloads the element rather than
              leaving the previous video's frame on screen. */}
          <video key={run.id} src={api.videoUrl(run.id)} controls preload="metadata" />
        </div>
      )}

      {run.lighthouse && (
        <div style={{ marginTop: 18 }}>
          <LighthousePanel report={run.lighthouse} runId={run.id} />
        </div>
      )}
    </div>
  );
}
