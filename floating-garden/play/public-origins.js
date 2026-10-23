// Local unactivated candidate. Origins are a host-wide boundary, not a folder.
export const PUBLIC_ALLOWED_ORIGINS = Object.freeze(['https://wa-awesome-garden-stg.web.app', 'https://fabdemnt-dev.github.io']);
export function isAllowedPublicOrigin(value) { return typeof value === 'string' && PUBLIC_ALLOWED_ORIGINS.includes(value); }
// Validate the raw URL authority too; URL parsing would normalize explicit :443.
export function hasExactPublicAuthority(href) {
  return typeof href === 'string' && PUBLIC_ALLOWED_ORIGINS.some(origin => href === origin || href.startsWith(origin + '/') || href.startsWith(origin + '?') || href.startsWith(origin + '#'));
}
