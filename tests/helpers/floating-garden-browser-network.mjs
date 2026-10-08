// This is diagnostic classification, NOT an outbound allowlist. Every matching
// request must still be aborted. WebChannel's default error-2 reachability check
// uses new Image and appends one random base-36 `zx` cache-buster (see installed
// @firebase/webchannel-wrapper/dist/webchannel-blob/esm/webchannel_blob_es2018.js).
export function isDeniedWebChannelConnectivityProbe({ url, method, resourceType, offlineExercised }) {
  if (!offlineExercised || method !== 'GET' || resourceType !== 'image') return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.origin !== 'https://www.google.com' || parsed.pathname !== '/images/cleardot.gif' || parsed.username || parsed.password || parsed.hash) return false;
  const params = [...parsed.searchParams];
  return params.length === 1 && params[0][0] === 'zx' && /^[a-z0-9]{1,32}$/.test(params[0][1]);
}

export async function abortDeniedBrowserRequest(route, { offlineExercised }) {
  const request = route.request();
  const diagnostic = isDeniedWebChannelConnectivityProbe({ url: request.url(), method: request.method(), resourceType: request.resourceType(), offlineExercised });
  await route.abort('blockedbyclient');
  return diagnostic;
}
