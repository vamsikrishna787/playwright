/**
 * The configuration layer.
 *
 * One YAML file per environment, layered over a shared base, the way a Spring
 * Boot application.yml plus a profile behaves. `APP_ENV` picks the profile and
 * defaults to `local`, so a fresh clone runs with no environment set at all.
 *
 * Values may carry `${VAR:default}` placeholders, resolved against the process
 * environment when the file is read. That is what keeps bucket names, endpoints
 * and ports out of a tracked file while leaving the *shape* of the config in
 * one readable place.
 *
 * Everything is read once, validated, and frozen. Nothing downstream reads
 * process.env directly — a setting that matters is a line in a profile.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

/** The `web/` directory. Next runs with this as its working directory. */
export const APP_ROOT = process.cwd();
export const CONFIG_DIR = path.join(APP_ROOT, 'src', 'config');

export const APP_ENV = (process.env.APP_ENV || 'local').trim().toLowerCase();

export type StorageProviderName = 'local' | 's3';

export interface AppConfig {
  env: string;
  app: { name: string; basePath: string; port: number };
  server: { tls: { enabled: boolean; certDir: string; mutual: boolean } };
  auth: { enabled: boolean; provider: string; headerName: string };
  agents: { baseUrl: string; timeoutMs: number };
  runs: { maxConcurrent: number; timeoutMs: number; historyLimit: number; workDir: string };
  lighthouse: { enabled: boolean; timeoutMs: number };
  storage: {
    provider: StorageProviderName;
    allowRuntimeToggle: boolean;
    local: { root: string };
    s3: {
      bucket: string;
      region: string;
      prefix: string;
      endpoint: string;
      forcePathStyle: boolean;
    };
  };
}

type Tree = Record<string, unknown>;

const isTree = (value: unknown): value is Tree =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Profile over base, deep. A profile states only what differs. */
function merge(base: unknown, overlay: unknown): unknown {
  if (!isTree(base) || !isTree(overlay)) return overlay === undefined ? base : overlay;
  const out: Tree = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = key in base ? merge(base[key], value) : value;
  }
  return out;
}

/**
 * `${VAR:default}` -> the environment, or the default, or ''.
 *
 * A default containing a colon is left intact (`${URL:http://host}` works),
 * because only the first colon separates the name from the default.
 */
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g;

function substitute(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (_match, name: string, fallback = '') => {
      const found = process.env[name];
      return found !== undefined && found !== '' ? found : fallback;
    });
  }
  if (Array.isArray(value)) return value.map(substitute);
  if (isTree(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
  }
  return value;
}

function readProfile(name: string): Tree {
  const file = path.join(CONFIG_DIR, `${name}.yml`);
  if (!fs.existsSync(file)) return {};
  const parsed = parse(fs.readFileSync(file, 'utf8'));
  return isTree(parsed) ? parsed : {};
}

/** Dotted lookup, so a missing branch is undefined rather than a throw. */
function at(tree: Tree, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((node, key) => (isTree(node) ? node[key] : undefined), tree);
}

const str = (tree: Tree, key: string, fallback: string): string => {
  const value = at(tree, key);
  return value === undefined || value === null ? fallback : String(value);
};

const num = (tree: Tree, key: string, fallback: number): number => {
  const parsed = Number(at(tree, key));
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** YAML gives real booleans; a resolved `${VAR}` gives the string it read. */
const bool = (tree: Tree, key: string, fallback: boolean): boolean => {
  const value = at(tree, key);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(text)) return true;
    if (['false', '0', 'no', 'off'].includes(text)) return false;
  }
  return fallback;
};

function build(): AppConfig {
  const tree = substitute(merge(readProfile('application'), readProfile(APP_ENV))) as Tree;

  const provider = str(tree, 'storage.provider', 'local').toLowerCase();
  if (provider !== 'local' && provider !== 's3') {
    throw new Error(
      `storage.provider in ${APP_ENV}.yml is "${provider}". It must be "local" or "s3".`,
    );
  }

  return Object.freeze({
    env: APP_ENV,
    app: {
      name: str(tree, 'app.name', 'Playwright Test Platform'),
      // A basePath of "/" is the same as none, and Next rejects the former.
      basePath: str(tree, 'app.basePath', '').replace(/\/$/, ''),
      port: num(tree, 'app.port', 5180),
    },
    server: {
      tls: {
        enabled: bool(tree, 'server.tls.enabled', false),
        certDir: str(tree, 'server.tls.certDir', '/eks/ssl'),
        mutual: bool(tree, 'server.tls.mutual', false),
      },
    },
    auth: {
      enabled: bool(tree, 'auth.enabled', false),
      provider: str(tree, 'auth.provider', 'none'),
      headerName: str(tree, 'auth.headerName', 'x-remote-user').toLowerCase(),
    },
    agents: {
      baseUrl: str(tree, 'agents.baseUrl', 'http://127.0.0.1:8000').replace(/\/$/, ''),
      timeoutMs: num(tree, 'agents.timeoutMs', 180_000),
    },
    runs: {
      maxConcurrent: Math.max(1, num(tree, 'runs.maxConcurrent', 2)),
      timeoutMs: num(tree, 'runs.timeoutMs', 600_000),
      historyLimit: num(tree, 'runs.historyLimit', 500),
      workDir: path.resolve(APP_ROOT, str(tree, 'runs.workDir', '.work')),
    },
    lighthouse: {
      enabled: bool(tree, 'lighthouse.enabled', true),
      timeoutMs: num(tree, 'lighthouse.timeoutMs', 180_000),
    },
    storage: {
      provider,
      allowRuntimeToggle: bool(tree, 'storage.allowRuntimeToggle', true),
      local: { root: path.resolve(APP_ROOT, str(tree, 'storage.local.root', '.data')) },
      s3: {
        bucket: str(tree, 'storage.s3.bucket', ''),
        region: str(tree, 'storage.s3.region', 'us-east-1'),
        prefix: str(tree, 'storage.s3.prefix', '').replace(/^\/+|\/+$/g, ''),
        endpoint: str(tree, 'storage.s3.endpoint', ''),
        forcePathStyle: bool(tree, 'storage.s3.forcePathStyle', false),
      },
    },
  }) as AppConfig;
}

export const appConfig: AppConfig = build();
