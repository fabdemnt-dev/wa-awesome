# Exact Firebase CDN regression fixtures

The three `firebase-*.js` files are unchanged official CDN ES module responses
for Firebase JavaScript SDK **10.8.0**, retrieved on 2026-10-03. Their canonical
URLs, byte lengths, and SHA-256 digests are recorded in `provenance.json`.
The original license notices and source-map comments are preserved. Source maps
are deliberately not vendored: tests do not open DevTools or fetch them.
`.gitattributes` disables line-ending conversion for integrity-pinned bytes.

Firebase's files carry Google LLC Apache-2.0 notices. `LICENSE` is the standard
Apache License 2.0 text, copied from the execution image's
`/usr/share/common-licenses/Apache-2.0`; the canonical license URL is recorded in
the provenance. No production client, runtime setting, or SDK byte was patched.

`fixture.mjs` is repository-owned test support, not part of the vendor SDK. It
verifies the bundles before use and supplies clearly synthetic response data.
It never imports/evaluates the SDK in Node's ambient environment and never
calls a live Firebase service. The fixture is outside the deployable tree.

Run:

- `npm run test:floating-garden:connection:sdk`: unchanged SDK/client modules
  in fresh Node VM contexts, synthetic browser services, and a modeled
  connect-src allowlist. It exercises the actual default dynamic SDK loader.
  This is an endpoint/flow contract test, not a browser CSP conformance test.
- `node --test tests/floating-garden-connection-browser.mjs`: real Chromium CSP
  and the unchanged SDK/client modules, a synthetic reCAPTCHA script, and fully
  intercepted network responses. The legacy CSP must fail before Auth or the
  identity-attempt guard; the actual current publisher CSP must succeed and
  preserve the same synthetic anonymous identity across duplicate clicks/reload.

All requests in the browser suite are fulfilled from fixtures or aborted;
there is no `route.continue`, `route.fetch`, live Auth, live App Check exchange,
real reCAPTCHA challenge, or production attestation. Service workers are blocked.
The VM also has no real transport. Passing these regressions does not establish
that live attestation or the user's device works; that remains a separate check.
