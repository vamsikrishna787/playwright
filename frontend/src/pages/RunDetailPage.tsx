import { Link, useParams } from 'react-router-dom';
import RunResult from '../components/RunResult';
import RunStatusBadge from '../components/RunStatusBadge';
import { usePollRun } from '../hooks/usePollRun';

export default function RunDetailPage() {
  const { id, runId } = useParams<{ id: string; runId: string }>();
  const { run, error } = usePollRun(runId);

  if (error) return <div className="error-box">{error}</div>;
  if (!run) return <p className="muted">Loading run…</p>;

  return (
    <>
      <p style={{ marginTop: 0 }}>
        <Link to={`/scripts/${id}`}>← Back to script</Link>
      </p>

      <div className="spread">
        <div>
          <h1>Run</h1>
          <p className="subtitle mono" style={{ marginBottom: 0 }}>
            {new Date(run.startedAt).toLocaleString()}
            {run.durationMs !== null && ` · ${(run.durationMs / 1000).toFixed(1)}s`}
          </p>
        </div>
        <RunStatusBadge status={run.status} />
      </div>

      <div style={{ marginTop: 24 }}>
        <RunResult run={run} />
      </div>
    </>
  );
}
