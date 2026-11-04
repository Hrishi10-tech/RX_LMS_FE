import { client } from './axios';
import { extractErrorMessage } from './extractErrorMessage';

/**
 * Download a server-rendered export (CSV / PDF) from an authenticated
 * endpoint and hand it to the browser as a file.
 *
 * Shared by every download surface — the bulk ExportPanel and the
 * single-record "Download slip" buttons — so the blob plumbing lives in
 * exactly one place: `responseType: 'blob'` (so axios doesn't try to JSON-
 * parse a binary body), filename lifted from the Content-Disposition header
 * the backend sets, programmatic anchor click, then a deferred revoke so the
 * browser has finished reading the object URL before we free it.
 *
 * Returns the resolved filename so the caller can toast "Downloaded X".
 */
/**
 * Fetches a slip (authenticated, as a blob) and returns an object URL for it,
 * so it can be VIEWED inline — embedded in an <iframe> inside an in-app modal,
 * no download, no new tab. Same auth path as downloadFromEndpoint (the bearer
 * token rides on the `client` request; a raw URL to the API would 401).
 *
 * The caller OWNS the returned URL and must `URL.revokeObjectURL(url)` when the
 * viewer closes, to free the blob.
 */
export async function fetchBlobUrl(
  path: string,
  params: Record<string, unknown>,
): Promise<string> {
  const res = await client.get(path, { params, responseType: 'blob' });
  const blob = new Blob([res.data], {
    type: String(res.headers['content-type'] || 'application/pdf'),
  });
  return URL.createObjectURL(blob);
}

export async function downloadFromEndpoint(
  path: string,
  params: Record<string, unknown>,
  fallbackName: string,
): Promise<string> {
  const res = await client.get(path, { params, responseType: 'blob' });
  const blob = new Blob([res.data], {
    type: String(res.headers['content-type'] || 'application/octet-stream'),
  });
  const url = URL.createObjectURL(blob);
  const cd = String(res.headers['content-disposition'] || '');
  const match = /filename="?([^";]+)"?/i.exec(cd);
  const filename = match?.[1] || fallbackName;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick so the browser actually finishes the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

/**
 * Pull a human-readable message out of a failed blob download. Axios delivers
 * error bodies for `responseType: 'blob'` requests as a Blob too, so the
 * JSON `{ message }` the backend threw is trapped inside — read + parse it,
 * else fall back to the standard extractor.
 */
export async function extractBlobError(e: unknown, fallback = 'Download failed'): Promise<string> {
  const data = (e as { response?: { data?: unknown } })?.response?.data;
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text());
      return parsed.message || fallback;
    } catch {
      return fallback;
    }
  }
  return extractErrorMessage(e, fallback);
}
