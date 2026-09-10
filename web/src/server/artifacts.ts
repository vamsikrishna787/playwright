/**
 * Serving what a run left behind.
 *
 * The stored paths are storage keys written by this application, but they are
 * read back out of a JSON index that a person can hand-edit, so every one is
 * re-checked on the way in — the storage layer refuses a key that walks out of
 * its own root.
 *
 * Reading through the provider rather than off disk is what makes the switch
 * invisible here: the same route serves a file from a directory or an object
 * from a bucket.
 */
import { getStorage, contentTypeFor } from './storage';
import { notFound } from './util/misc';

interface ServeOptions {
  /** Overrides the type inferred from the key's extension. */
  contentType?: string;
  /** Honour a Range header. Worth it for video, pointless for a report. */
  ranged?: boolean;
  request?: Request;
}

/**
 * A stored object as an HTTP response.
 *
 * Buffered rather than streamed: the largest thing here is a 30-second 720p
 * recording, and buffering keeps one code path for both providers.
 */
export async function serveArtifact(
  key: string | null | undefined,
  missing: string,
  options: ServeOptions = {},
): Promise<Response> {
  if (!key) throw notFound(missing);

  const storage = await getStorage();
  const bytes = await storage.readBytes(key);
  if (!bytes) throw notFound(missing);

  const contentType = options.contentType ?? contentTypeFor(key);
  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': 'private, max-age=300',
  });

  const range = options.ranged ? options.request?.headers.get('range') : null;
  if (range) {
    // Seeking in the video player needs this; a browser that does not ask for a
    // range still gets the whole thing below.
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;

      if (Number.isFinite(start) && start <= end && start < bytes.length) {
        const slice = bytes.subarray(start, end + 1);
        headers.set('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Content-Length', String(slice.length));
        return new Response(new Uint8Array(slice), { status: 206, headers });
      }
    }
  }

  if (options.ranged) headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(bytes.length));
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}
