// DISABLED SOURCE TEMPLATE. The local-only preparation script replaces this module
// in an isolated output directory, from an explicitly supplied and verified config.
// These public web settings are NOT tester enrollment or authorization.
// The operator must verify every Web App identifier belongs to the approved NEW
// project; projectId/authDomain text and key syntax do not establish ownership.
export default Object.freeze({
  schemaVersion: 1,
  enabled: false,
  projectId: '',
  previewOrigin: '',
  startsAtMillis: 0,
  endsAtMillis: 0,
  region: 'asia-northeast1',
  maxTesters: 2,
  maxRooms: 20,
  firebase: Object.freeze({ apiKey: '', authDomain: '', projectId: '', appId: '' }),
  appCheck: Object.freeze({ provider: 'recaptcha-enterprise', siteKey: '', verified: false }),
});
