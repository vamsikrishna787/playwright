'use client';

import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { StorageProviderName, StorageStatus } from '../../types';
import styles from './SettingsPage.module.css';

/**
 * Where everything is saved.
 *
 * One switch, and it moves the lot: the suite, test and run indexes, every
 * generated spec, and every report, recording and Lighthouse audit a run
 * produced. The active profile sets the default; this page is the runtime
 * override of it, and a profile can refuse the override entirely — which prod
 * does, because nobody should be able to move production data onto a pod's disk
 * from a web page.
 *
 * Two things are deliberately explicit here. The destination is checked before
 * anything moves, so a wrong bucket name leaves the platform where it was. And
 * copying what is already saved is a choice rather than a default, because the
 * switch is sometimes pointed at data that is already there.
 */
export default function SettingsPage() {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [copyExisting, setCopyExisting] = useState(true);

  useEffect(() => {
    api
      .storage()
      .then(setStatus)
      .catch((failure: Error) => setError(failure.message));
  }, []);

  const switchTo = async (provider: StorageProviderName) => {
    if (!status || provider === status.active || busy) return;

    const target = status.providers.find((entry) => entry.name === provider);
    const moving = copyExisting
      ? `Copy everything saved to ${target?.target} and save there from now on?`
      : `Save to ${target?.target} from now on? What is already saved stays where it is.`;
    if (!confirm(moving)) return;

    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await api.setStorage(provider, copyExisting);
      setStatus(next);
      setNotice(
        next.copied
          ? `Now saving to ${next.target} — ${next.copied} object${next.copied === 1 ? '' : 's'} copied across.`
          : `Now saving to ${next.target}.`,
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return error ? (
      <div className="error-banner">{error}</div>
    ) : (
      <div className="empty">Loading…</div>
    );
  }

  const locked = !status.allowRuntimeToggle;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Storage</h1>
          <p className="muted" style={{ margin: 0, maxWidth: 640 }}>
            Where suites, tests, generated scripts and every run&rsquo;s reports, recordings and
            Lighthouse audits are saved. One switch moves all of it.
          </p>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && !error && <div className="note">{notice}</div>}

      <div className="card">
        <div className={styles.switchRow}>
          {status.providers.map((provider) => {
            const active = provider.name === status.active;
            const disabled = busy || locked || !provider.available;

            return (
              <button
                key={provider.name}
                type="button"
                className={`${styles.option} ${active ? styles.active : ''}`}
                onClick={() => switchTo(provider.name)}
                disabled={disabled && !active}
                title={provider.reason ?? provider.target}
              >
                <span className={styles.optionHead}>
                  <span className={styles.optionName}>{provider.label}</span>
                  {active && <span className="badge passed">active</span>}
                </span>
                <span className={`mono ${styles.optionTarget}`}>{provider.target}</span>
                {provider.reason && <span className={styles.reason}>{provider.reason}</span>}
              </button>
            );
          })}
        </div>

        <label className={styles.copyRow}>
          <input
            type="checkbox"
            checked={copyExisting}
            disabled={locked}
            onChange={(event) => setCopyExisting(event.target.checked)}
          />
          <span>
            Copy what is already saved to the new location
            <span className="small muted">
              {' '}
              — without this the switch points at whatever is already there.
            </span>
          </span>
        </label>

        {locked && (
          <div className="note" style={{ marginTop: 14, marginBottom: 0 }}>
            The switch is disabled in the <b>{status.env}</b> profile. Change{' '}
            <code className="mono">storage.provider</code> in{' '}
            <code className="mono">src/config/{status.env}.yml</code> and restart.
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Current state</h3>
        <div className={styles.facts}>
          <div>
            <span>Saving to</span>
            <span className="mono">{status.target}</span>
          </div>
          <div>
            <span>Reachable</span>
            <span>
              <span
                className="dot"
                style={{ color: status.check.ok ? 'var(--pass)' : 'var(--fail)' }}
              />{' '}
              {status.check.detail}
            </span>
          </div>
          <div>
            <span>Profile</span>
            <span className="mono">
              {status.env}.yml &rarr; {status.configured}
            </span>
          </div>
          <div>
            <span>Runtime override</span>
            <span>
              {status.override ? (
                <>
                  <span className="mono">{status.override}</span>
                  {status.overriddenAt && (
                    <span className="small muted">
                      {' '}
                      since {new Date(status.overriddenAt).toLocaleString()}
                    </span>
                  )}
                </>
              ) : (
                <span className="muted">none — following the profile</span>
              )}
            </span>
          </div>
        </div>

        {status.override && !locked && (
          <div className="actions" style={{ marginTop: 14 }}>
            <button onClick={() => switchTo(status.configured)} disabled={busy}>
              Reset to the profile default ({status.configured})
            </button>
          </div>
        )}
      </div>

      <p className="muted small" style={{ marginTop: 16, maxWidth: 640 }}>
        A run itself always happens on local disk — Playwright and Lighthouse are child processes
        writing real files — and what it produced is published to the active provider when it
        finishes. That is why switching to S3 does not need a shared filesystem.
      </p>
    </div>
  );
}
