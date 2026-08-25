import type { RunStatus } from '../types';

export function StatusBadge({ status }: { status: RunStatus | null | undefined }) {
  if (!status) return <span className="badge">never run</span>;

  const busy = status === 'running' || status === 'queued';
  return (
    <span className={`badge ${status}`}>
      <span className={`dot${busy ? ' spin' : ''}`} />
      {status}
    </span>
  );
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms && ms !== 0) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
