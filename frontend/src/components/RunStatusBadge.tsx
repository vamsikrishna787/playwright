import type { RunStatus } from '../types';

export default function RunStatusBadge({ status }: { status: RunStatus }) {
  const isActive = status === 'running' || status === 'queued';
  return (
    <span className={`badge ${status}`}>
      {isActive && <span className="spinner" />}
      {status}
    </span>
  );
}
