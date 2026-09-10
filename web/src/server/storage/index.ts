/**
 * Choosing where everything is saved.
 *
 * The active profile names a provider — `storage.provider: local` or `s3` — and
 * that is the whole switch. Nothing else in the application knows which one it
 * got.
 *
 * On top of the configured default there is a runtime override, which is what
 * the toggle on the Settings page writes. The override lives on local disk
 * beside the work directory rather than in storage, for the obvious reason: it
 * is the thing that decides which storage to open. A profile can refuse the
 * override entirely (`storage.allowRuntimeToggle: false`, which prod sets), so
 * nobody can move production data onto a pod's disk from a web page.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { appConfig, type StorageProviderName } from '../../config/appConfig';
import { LocalStorage } from './local';
import { S3Storage } from './s3';
import type { StorageCheck, StorageProvider } from './types';

export type { StorageProvider, StoredObject, StorageCheck } from './types';
export { contentTypeFor, normaliseKey } from './types';

const OVERRIDE_FILE = path.join(appConfig.runs.workDir, 'storage-override.json');

interface Override {
  provider: StorageProviderName;
  changedAt: string;
}

function create(name: StorageProviderName): StorageProvider {
  return name === 's3'
    ? new S3Storage(appConfig.storage.s3)
    : new LocalStorage(appConfig.storage.local.root);
}

/** Why a provider cannot be selected right now, or null if it can. */
function unavailableReason(name: StorageProviderName): string | null {
  if (name === 's3' && !appConfig.storage.s3.bucket) {
    return 'No bucket configured. Set S3_BUCKET, or storage.s3.bucket in the active profile.';
  }
  return null;
}

let active: StorageProvider | null = null;
let activeName: StorageProviderName | null = null;
let override: Override | null = null;
let loaded = false;

async function readOverride(): Promise<Override | null> {
  if (!appConfig.storage.allowRuntimeToggle) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(OVERRIDE_FILE, 'utf8')) as Override;
    return parsed.provider === 'local' || parsed.provider === 's3' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The provider every caller uses.
 *
 * Resolved once and held: building an S3 client per request would rebuild the
 * credential chain each time.
 */
export async function getStorage(): Promise<StorageProvider> {
  if (active) return active;

  if (!loaded) {
    override = await readOverride();
    loaded = true;
  }

  const wanted = override?.provider ?? appConfig.storage.provider;
  try {
    active = create(wanted);
  } catch (error) {
    // A stale override pointing at a provider that is no longer configured must
    // not take the whole application down - fall back and say so.
    if (wanted !== appConfig.storage.provider) {
      console.error(
        `[storage] the saved override (${wanted}) cannot start, falling back to ${appConfig.storage.provider}:`,
        error instanceof Error ? error.message : error,
      );
      override = null;
      active = create(appConfig.storage.provider);
    } else {
      throw error;
    }
  }

  activeName = active.name;
  console.log(`[storage] ${activeName} -> ${active.target}`);
  return active;
}

export interface StorageStatus {
  active: StorageProviderName;
  configured: StorageProviderName;
  /** Set when the toggle has moved storage away from what the profile says. */
  override: StorageProviderName | null;
  overriddenAt: string | null;
  allowRuntimeToggle: boolean;
  env: string;
  target: string;
  providers: Array<{
    name: StorageProviderName;
    label: string;
    target: string;
    available: boolean;
    reason: string | null;
  }>;
}

export async function storageStatus(): Promise<StorageStatus> {
  const storage = await getStorage();
  const s3 = appConfig.storage.s3;

  return {
    active: storage.name,
    configured: appConfig.storage.provider,
    override: override?.provider ?? null,
    overriddenAt: override?.changedAt ?? null,
    allowRuntimeToggle: appConfig.storage.allowRuntimeToggle,
    env: appConfig.env,
    target: storage.target,
    providers: [
      {
        name: 'local',
        label: 'Local disk',
        target: appConfig.storage.local.root,
        available: true,
        reason: null,
      },
      {
        name: 's3',
        label: 'Amazon S3',
        target: s3.bucket ? `s3://${s3.bucket}/${s3.prefix ? `${s3.prefix}/` : ''}` : 'not configured',
        available: unavailableReason('s3') === null,
        reason: unavailableReason('s3'),
      },
    ],
  };
}

/** Reaches the *active* destination, for the dot on the Settings page. */
export async function checkStorage(): Promise<StorageCheck> {
  return (await getStorage()).check();
}

export interface SwitchResult {
  status: StorageStatus;
  copied: number;
  check: StorageCheck;
}

/**
 * Flips the switch.
 *
 * The destination is checked before anything is moved, so a bad bucket name
 * leaves the platform exactly where it was rather than pointing at storage that
 * does not answer. `copyExisting` mirrors what is already saved into the new
 * provider — without it the switch is a move to an empty shelf, which is
 * occasionally what you want and usually a surprise.
 */
export async function setStorageProvider(
  name: StorageProviderName,
  options: { copyExisting?: boolean } = {},
): Promise<SwitchResult> {
  if (!appConfig.storage.allowRuntimeToggle) {
    throw new Error(
      `The storage toggle is disabled in the "${appConfig.env}" profile. Change storage.provider in ${appConfig.env}.yml and restart.`,
    );
  }

  const reason = unavailableReason(name);
  if (reason) throw new Error(reason);

  const from = await getStorage();
  const to = name === from.name ? from : create(name);

  const check = await to.check();
  if (!check.ok) {
    throw new Error(`${name} storage is not usable, so nothing was moved: ${check.detail}`);
  }

  let copied = 0;
  if (options.copyExisting && to !== from) {
    copied = await copyAll(from, to);
  }

  if (to !== from) {
    active = to;
    activeName = to.name;
  }

  // Only a real departure from the profile is worth persisting; going back to
  // what the profile says removes the override rather than recording it.
  if (name === appConfig.storage.provider) {
    override = null;
    await fs.rm(OVERRIDE_FILE, { force: true });
  } else {
    override = { provider: name, changedAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(OVERRIDE_FILE), { recursive: true });
    await fs.writeFile(OVERRIDE_FILE, JSON.stringify(override, null, 2), 'utf8');
  }

  console.log(`[storage] switched to ${to.name} -> ${to.target}${copied ? ` (${copied} object(s) copied)` : ''}`);
  return { status: await storageStatus(), copied, check };
}

/** Everything saved, moved across. Bytes, so a video survives the trip intact. */
async function copyAll(from: StorageProvider, to: StorageProvider): Promise<number> {
  const objects = await from.list('');
  let copied = 0;

  for (const object of objects) {
    // The write probes each provider leaves behind are not data.
    if (object.key.startsWith('.check/')) continue;
    const bytes = await from.readBytes(object.key);
    if (!bytes) continue;
    await to.writeBytes(object.key, bytes);
    copied += 1;
  }
  return copied;
}
