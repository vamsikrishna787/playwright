import { api } from '../api/client';
import type { LighthouseReport } from '../types';

const CATEGORIES: Array<{ key: keyof LighthouseReport['scores']; label: string }> = [
  { key: 'performance', label: 'Performance' },
  { key: 'accessibility', label: 'Accessibility' },
  { key: 'bestPractices', label: 'Best practices' },
  { key: 'seo', label: 'SEO' },
];

const METRICS: Array<{ key: keyof LighthouseReport['metrics']; label: string }> = [
  { key: 'firstContentfulPaint', label: 'First contentful paint' },
  { key: 'largestContentfulPaint', label: 'Largest contentful paint' },
  { key: 'totalBlockingTime', label: 'Total blocking time' },
  { key: 'cumulativeLayoutShift', label: 'Cumulative layout shift' },
  { key: 'speedIndex', label: 'Speed index' },
];

/** Lighthouse's own thresholds: 90+ is good, 50–89 needs work, below 50 is poor. */
const band = (score: number) => (score >= 90 ? 'good' : score >= 50 ? 'average' : 'poor');

export default function LighthousePanel({
  report,
  runId,
}: {
  report: LighthouseReport;
  runId: string;
}) {
  if (report.status === 'queued' || report.status === 'running') {
    return (
      <div className="card empty">
        <span className="spinner" />
        {report.status === 'queued'
          ? 'Lighthouse audit queued — it starts once the test finishes.'
          : 'Auditing the page with Lighthouse. This takes about half a minute.'}
      </div>
    );
  }

  if (report.status === 'error') {
    return (
      <div className="error-box">
        Lighthouse could not audit this page.
        {report.error && <div style={{ marginTop: 8 }}>{report.error}</div>}
      </div>
    );
  }

  if (report.status === 'skipped') {
    return <div className="card empty">Lighthouse auditing is switched off.</div>;
  }

  const metrics = METRICS.filter(({ key }) => report.metrics[key]);

  return (
    <div className="card">
      <div className="lh-scores">
        {CATEGORIES.map(({ key, label }) => {
          const score = report.scores[key];
          return (
            <div key={key} className="lh-score">
              {typeof score === 'number' ? (
                <>
                  <div
                    className={`lh-ring ${band(score)}`}
                    // The ring fills clockwise in proportion to the score.
                    style={{ ['--pct' as string]: `${score * 3.6}deg` }}
                  >
                    <span>{score}</span>
                  </div>
                  <div className="lh-label">{label}</div>
                </>
              ) : (
                <>
                  <div className="lh-ring missing">
                    <span>—</span>
                  </div>
                  <div className="lh-label muted">{label}</div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {metrics.length > 0 && (
        <ul className="lh-metrics">
          {metrics.map(({ key, label }) => (
            <li key={key}>
              <span className="muted">{label}</span>
              <span className="mono">{report.metrics[key]}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="spread lh-foot">
        <span className="muted mono">{report.url}</span>
        {report.reportPath && (
          <a href={api.lighthouseUrl(runId)} target="_blank" rel="noreferrer">
            Open full Lighthouse report
          </a>
        )}
      </div>
    </div>
  );
}
