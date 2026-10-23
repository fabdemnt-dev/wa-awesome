// Exact host-wide boundary, NOT a /wa-awesome or /floating-garden folder boundary.
// No staging, preview, alternate host, query override, or fallback is enabled here.
export const PUBLIC_ALLOWED_ORIGINS = Object.freeze(['https://fabdemnt-dev.github.io']);
export function isAllowedPublicOrigin(value) { return typeof value === 'string' && PUBLIC_ALLOWED_ORIGINS.includes(value); }
// Inspect the raw authority too; URL parsing normalizes explicit default ports.
export function hasExactPublicAuthority(href) {
  return typeof href === 'string' && PUBLIC_ALLOWED_ORIGINS.some(origin => href === origin || href.startsWith(origin + '/') || href.startsWith(origin + '?') || href.startsWith(origin + '#'));
}
