import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------- hash router
// Hash routes keep deep links working on S3 static website hosting.

export type Route =
  | { page: 'home' }
  | { page: 'suite'; suiteId: string }
  | { page: 'new-test'; suiteId: string }
  | { page: 'test'; suiteId: string; testId: string; runId?: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'suites' && parts[1]) {
    if (parts[2] === 'tests' && parts[3] === 'new') return { page: 'new-test', suiteId: parts[1] };
    if (parts[2] === 'tests' && parts[3]) {
      return { page: 'test', suiteId: parts[1], testId: parts[3], runId: parts[4] === 'runs' ? parts[5] : undefined };
    }
    return { page: 'suite', suiteId: parts[1] };
  }
  return { page: 'home' };
}

export const paths = {
  home: () => '#/',
  suite: (suiteId: string) => `#/suites/${suiteId}`,
  newTest: (suiteId: string) => `#/suites/${suiteId}/tests/new`,
  test: (suiteId: string, testId: string) => `#/suites/${suiteId}/tests/${testId}`,
  run: (suiteId: string, testId: string, runId: string) => `#/suites/${suiteId}/tests/${testId}/runs/${runId}`,
};

export function navigate(hash: string) {
  window.location.hash = hash;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

// ---------------------------------------------------------------- data loading

/**
 * Load data for `key`, and keep re-loading every `intervalMs` while `shouldPoll(data)` is true.
 * `refresh()` reloads immediately and restarts polling (use it after a mutation such as "Generate").
 */
export function usePolledResource<T>(
  load: () => Promise<T>,
  key: string,
  shouldPoll: (data: T) => boolean = () => false,
  intervalMs = 3000,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const pollRef = useRef(shouldPoll);
  pollRef.current = shouldPoll;

  useEffect(() => {
    setData(null);
    setError(null);
  }, [key]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const value = await loadRef.current();
        if (cancelled) return;
        setData(value);
        setError(null);
        if (pollRef.current(value)) timer = window.setTimeout(tick, intervalMs);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [key, version, intervalMs]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, loading: data === null && error === null, refresh };
}

// ---------------------------------------------------------------- app-wide events

const SUITES_CHANGED = 'e2e-studio:suites-changed';
export const notifySuitesChanged = () => window.dispatchEvent(new Event(SUITES_CHANGED));
export function useSuitesChanged(handler: () => void) {
  useEffect(() => {
    window.addEventListener(SUITES_CHANGED, handler);
    return () => window.removeEventListener(SUITES_CHANGED, handler);
  }, [handler]);
}

// ---------------------------------------------------------------- formatting

export function timeAgo(iso?: string | null): string {
  if (!iso) return '-';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatDuration(ms?: number | null): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDateTime(iso?: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '-';
}

export const isActive = (status?: string | null) => status === 'queued' || status === 'running';

/** A run is still producing results while the test runs or while its Lighthouse audit is running. */
export const runInProgress = (run?: { status: string; lighthouseStatus?: string } | null) =>
  !!run && (isActive(run.status) || run.lighthouseStatus === 'running');
