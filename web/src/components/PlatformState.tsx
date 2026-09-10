'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { StorageProviderName } from '../types';
import styles from './PlatformState.module.css';

interface State {
  agents: 'checking' | 'up' | 'down';
  storage: { provider: StorageProviderName; target: string } | null;
}

/**
 * The two things worth a permanent corner of the header.
 *
 * Whether the Python tier is answering: "Generate does nothing" is almost always
 * that process not being up, and without this the only clue is an error on a
 * button press a minute into writing a test.
 *
 * And where the platform is currently saving. A toggle that moves every suite,
 * script and report between a disk and a bucket should never leave you guessing
 * which one is live, so it is on screen on every page and links to the switch.
 */
export default function PlatformState() {
  const [state, setState] = useState<State>({ agents: 'checking', storage: null });

  useEffect(() => {
    let cancelled = false;

    const check = () =>
      api
        .health()
        .then((body) => {
          if (cancelled) return;
          setState({ agents: body.agentApi.reachable ? 'up' : 'down', storage: body.storage });
        })
        .catch(() => !cancelled && setState((held) => ({ ...held, agents: 'down' })));

    check();
    const timer = setInterval(check, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const label =
    state.agents === 'checking'
      ? 'checking agents…'
      : state.agents === 'up'
        ? 'agents ready'
        : 'agents offline';

  const colour =
    state.agents === 'up' ? 'var(--pass)' : state.agents === 'down' ? 'var(--fail)' : 'var(--muted)';

  return (
    <div className={styles.state}>
      <span className={styles.item} title="The Python agent API">
        <span className="dot" style={{ color: colour }} />
        {label}
      </span>

      <Link
        href="/settings"
        className={styles.storage}
        title={state.storage ? `Saving to ${state.storage.target}` : 'Storage settings'}
      >
        {state.storage?.provider === 's3' ? 'S3' : 'local disk'}
      </Link>
    </div>
  );
}
