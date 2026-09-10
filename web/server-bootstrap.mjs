/**
 * The production entry point.
 *
 * Wraps the Next request handler in a Node server of our own, so the pod can
 * terminate TLS — and mutual TLS, where the profile asks for it — instead of
 * relying on a sidecar. When TLS is off, or the certificates are not where the
 * profile says they are, it falls back to plain HTTP and says so rather than
 * refusing to boot.
 *
 * `npm run dev` bypasses this file entirely: `next dev` is its own server, and
 * a developer does not want to mint a certificate to see a page.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import next from 'next';
import { parse } from 'yaml';

const APP_ROOT = process.cwd();

/**
 * A deliberately small reader: this runs before the application's own config
 * layer exists, and only needs the port and the TLS block. Everything else is
 * read properly by src/config/appConfig.ts once Next is up.
 */
function readSetting(dotted, fallback) {
  const env = (process.env.APP_ENV || 'local').trim().toLowerCase();
  for (const profile of [env, 'application']) {
    const file = path.join(APP_ROOT, 'src', 'config', `${profile}.yml`);
    if (!fs.existsSync(file)) continue;

    const value = dotted
      .split('.')
      .reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined),
        parse(fs.readFileSync(file, 'utf8')));

    if (value === undefined || value === null) continue;

    // ${VAR:default}, the same placeholder form the config layer resolves.
    const resolved = String(value).replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g,
      (_match, name, defaultValue = '') => process.env[name] || defaultValue,
    );
    if (resolved !== '') return resolved;
  }
  return fallback;
}

const port = Number(readSetting('app.port', 5180));
const tlsEnabled = ['1', 'true', 'yes', 'on'].includes(
  String(readSetting('server.tls.enabled', 'false')).toLowerCase(),
);
const certDir = readSetting('server.tls.certDir', '/eks/ssl');
const mutual = ['1', 'true', 'yes', 'on'].includes(
  String(readSetting('server.tls.mutual', 'false')).toLowerCase(),
);

/** tls.crt / tls.key / ca.crt, the names a Kubernetes TLS secret mounts. */
function readCertificates() {
  const read = (name) => {
    const file = path.join(certDir, name);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  };

  const cert = read('tls.crt');
  const key = read('tls.key');
  if (!cert || !key) return null;

  const ca = read('ca.crt');
  if (mutual && !ca) {
    console.warn(`[boot] mutual TLS is on but ${path.join(certDir, 'ca.crt')} is missing.`);
  }

  return {
    cert,
    key,
    ...(ca ? { ca } : {}),
    requestCert: mutual,
    rejectUnauthorized: mutual && Boolean(ca),
  };
}

const app = next({ dev: false, dir: APP_ROOT });
await app.prepare();
const handler = app.getRequestHandler();

const certificates = tlsEnabled ? readCertificates() : null;
if (tlsEnabled && !certificates) {
  console.warn(`[boot] TLS is enabled but no tls.crt/tls.key under ${certDir}; serving HTTP.`);
}

const server = certificates
  ? https.createServer(certificates, (request, response) => handler(request, response))
  : http.createServer((request, response) => handler(request, response));

server.listen(port, () => {
  const scheme = certificates ? 'https' : 'http';
  console.log(`[boot]    ${scheme}://localhost:${port}${certificates && mutual ? ' (mTLS)' : ''}`);
});
