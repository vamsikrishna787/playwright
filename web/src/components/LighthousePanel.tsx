'use client';

import { api } from '../api/client';
import type { LighthouseReport } from '../types';

/** Lighthouse's own thresholds: 90+ is good, 50-89 needs work, below 50 is poor. */
const grade = (score: number | null) =>
  score === null ? '' : score >= 90 ? 'good' : score >= 50 ? 'ok' : 'bad';

const LABELS: Record<string, string> = {
  performance: 'Performance',
  accessibility: 'Accessibility',
  bestPractices: 'Best practices',
  seo: 'SEO',
  firstContentfulPaint: 'First contentful paint',
  largestContentfulPaint: 'Largest contentful paint',
  totalBlockingTime: 'Total blocking time',
  cumulativeLayoutShift: 'Cumulative layout shift',
  speedIndex: 'Speed index',
};

/**
 * The Lighthouse audit for the page the test started on.
 *
 * Presented apart from the verdict on purpose: it says nothing about whether
 * the test passed, only what shape the page was in while it ran.
 */
export default function LighthousePanel({
  report,
  runId,
}: {
  report: LighthouseReport;
  runId: string;
}) {
  if (report.status === 'running' || report.status === 'queued') {
    return (
      <div className="card">
        <h3>Lighthouse</h3>
        <p className="muted small" style={{ margin: 0 }}>
          <span className="dot spin" style={{ color: 'var(--run)' }} /> Auditing {report.url} — this
          runs after the test verdict and takes about half a minute.
        </p>
      </div>
    );
  }

  if (report.status === 'error') {
    return (
      <div className="card">
        <h3>Lighthouse</h3>
        <p className="small" style={{ color: 'var(--fail)', margin: 0 }}>
          {report.error}
        </p>
      </div>
    );
  }

  if (report.status === 'skipped') return null;

  const metrics = Object.entries(report.metrics).filter(([, value]) => value);

  return (
    <div className="card">
      <div className="page-head" style={{ marginBottom: 12 }}>
        <div>
          <h3 style={{ marginBottom: 2 }}>Lighthouse</h3>
          <span className="small muted mono">{report.url}</span>
        </div>
        {report.reportPath && (
          <a href={api.lighthouseUrl(runId)} target="_blank" rel="noreferrer">
            <button>Full report</button>
          </a>
        )}
      </div>

      <div className="scores">
        {Object.entries(report.scores).map(([key, score]) => (
          <div className={`score ${grade(score)}`} key={key}>
            <div className="val">{score ?? '—'}</div>
            <div className="name">{LABELS[key] ?? key}</div>
          </div>
        ))}
      </div>

      {metrics.length > 0 && (
        <div className="metrics">
          {metrics.map(([key, value]) => (
            <div key={key}>
              <span>{LABELS[key] ?? key}</span>
              <span className="mono">{value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
