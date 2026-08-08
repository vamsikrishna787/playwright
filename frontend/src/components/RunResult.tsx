import { api } from '../api/client';
import LighthousePanel from './LighthousePanel';
import StepList from './StepList';
import VideoPlayer from './VideoPlayer';
import type { RunRecord } from '../types';

/** Shared body of a run's outcome — used full-page and inline under the editor. */
export default function RunResult({ run }: { run: RunRecord }) {
  const inFlight = run.status === 'running' || run.status === 'queued';

  if (inFlight) {
    return (
      <div className="card empty">
        <span className="spinner" />
        {run.status === 'queued'
          ? 'Queued behind other runs. Results appear here when it finishes.'
          : 'Test is running. Video and results appear here when it finishes.'}
      </div>
    );
  }

  return (
    <>
      <div className="grid-2">
        <div>
          <h2 style={{ marginTop: 0 }}>Recording</h2>
          {run.videoPath ? (
            <VideoPlayer src={api.videoUrl(run.id)} />
          ) : (
            <div className="card empty">No video was recorded for this run.</div>
          )}
        </div>

        <div>
          <h2 style={{ marginTop: 0 }}>Tests</h2>
          {run.tests.length > 0 ? (
            run.tests.map((t, i) => (
              <div key={i} className="test-block">
                <div className="test-head">
                  <span className={`badge ${t.status}`}>{t.status}</span>
                  <span className="test-title">{t.title}</span>
                  <span className="muted mono">{t.durationMs}ms</span>
                </div>
                <StepList steps={t.steps} />
                {t.error && <div className="error-box test-error">{t.error}</div>}
              </div>
            ))
          ) : (
            // Runs recorded before per-test reporting only have flattened steps.
            <StepList steps={run.steps} />
          )}
        </div>
      </div>

      {run.error && run.tests.length === 0 && (
        <>
          <h2>Error</h2>
          <div className="error-box">{run.error}</div>
        </>
      )}

      {run.lighthouse && (
        <>
          <h2>
            Lighthouse
            <span className="muted" style={{ fontWeight: 400 }}>
              {' '}
              · page health, measured separately from the test
            </span>
          </h2>
          <LighthousePanel report={run.lighthouse} runId={run.id} />
        </>
      )}

      <p style={{ marginTop: 20 }}>
        <a href={api.reportUrl(run.id)} target="_blank" rel="noreferrer">
          View raw JSON report
        </a>
      </p>
    </>
  );
}
