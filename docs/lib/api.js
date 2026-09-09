/**
 * Apps Script transport.
 *
 * Three rules here are not style choices — each one is a thing that breaks:
 *
 * 1. POST with `Content-Type: text/plain`. Apps Script cannot answer a CORS
 *    preflight, and `application/json` triggers one. So no custom headers may
 *    ever be required either: the idempotency key travels in the BODY.
 * 2. `redirect: 'follow'` — /exec 302s to googleusercontent.com.
 * 3. A non-JSON response body must be classified RETRYABLE, not thrown. When
 *    Apps Script times out or needs authorization it returns an HTML page with
 *    HTTP 200. If `res.json()` is allowed to throw, that kills the flush loop
 *    and the queue stops draining for reasons nobody can see.
 */

export const API_TIMEOUT_MS = 20000;

export class ApiError extends Error {
  constructor(code, message, retryable) {
    super(message);
    this.code = code;
    this.retryable = !!retryable;
  }
}

let SCRIPT_URL = '';
export function configure(url) { SCRIPT_URL = url; }
export function isConfigured() { return /^https:\/\/script\.google\.com\//.test(SCRIPT_URL); }

async function call(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...init, redirect: 'follow', signal: ctrl.signal });
  } catch (err) {
    // Offline, DNS, abort, captive portal — all transient by definition.
    throw new ApiError('NETWORK', err.name === 'AbortError'
      ? 'The server took too long to answer'
      : 'No connection to the server', true);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // HTML instead of JSON. Two known shapes, and they need different messages.
    if (/Authorization needed|authorization is required/i.test(text)) {
      throw new ApiError('NEEDS_AUTH',
        'The app has not been authorised yet. The owner needs to open the script once and approve access.',
        true);
    }
    if (/unable to open the file/i.test(text)) {
      throw new ApiError('BAD_DEPLOYMENT',
        'The server address is not serving the app. The deployment needs republishing.',
        true);
    }
    throw new ApiError('BAD_RESPONSE',
      'The server sent something unexpected. Your entries are safe and will retry.',
      true);
  }

  if (body && body.ok === false && body.error) {
    // EMPTY_BODY means the request did not arrive intact — transport, not data.
    // Treated as retryable server-side too; asserted here so a future change to
    // the envelope cannot quietly make a lost entry permanent.

    throw new ApiError(body.error.code || 'UNKNOWN',
      body.error.message || 'Something went wrong',
      // Unknown failures default to retryable: a needless retry costs nothing,
      // a wrong drop loses the yard's data.
      body.error.retryable !== false);
  }
  if (!body || body.ok !== true) {
    throw new ApiError('BAD_RESPONSE', 'The server sent an unrecognised reply', true);
  }
  return body;
}

export function apiGet(action, params = {}) {
  if (!isConfigured()) {
    throw new ApiError('NOT_CONFIGURED', 'The app is not linked to a server yet', false);
  }
  const q = new URLSearchParams({ action, ...params });
  return call(`${SCRIPT_URL}?${q}`, { method: 'GET' });
}

export function apiPost(action, payload = {}) {
  if (!isConfigured()) {
    throw new ApiError('NOT_CONFIGURED', 'The app is not linked to a server yet', false);
  }
  return call(`${SCRIPT_URL}?action=${encodeURIComponent(action)}`, {
    method: 'POST',
    // text/plain avoids the CORS preflight Apps Script cannot answer.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });
}

/**
 * A real connectivity probe. `navigator.onLine` returns true on corporate wifi
 * with no route to Google, which is exactly the yard's failure mode.
 */
export async function probe() {
  try {
    await apiGet('ping');
    return true;
  } catch {
    return false;
  }
}
