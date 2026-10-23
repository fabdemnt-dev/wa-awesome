# Exact Firebase CDN regression fixtures

The three connection-regression `firebase-*.js` files are unchanged official CDN ES module responses
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

## Test-only Firestore watch diagnostics

`firebase-firestore.js` is a separate, unchanged official 10.8.0 CDN response,
retrieved on 2026-10-04 and pinned independently in `firestore-provenance.json`.
The connection fixtures' original provenance, pinned modules, and behavior do
not include or depend on this additional file.

`tests/helpers/floating-garden-trial-sdk-discard-fixture.mjs` verifies the exact
434,464 bytes, SHA-256, one occurrence of each exact source anchor, and absent
private hook names before adding two diagnostic comma expressions to the
in-memory response. A mismatch fails closed. Only a GET for the exact original
Firestore URL with `?trial-emulator-original=1` receives this instrumented
response in the trial emulator browser test. No patched vendor file is saved.

The first hook observes the Listen stream just before the existing log/callback
expression. It copies incoming room/match revisions and timestamp seconds/nanos,
or a fixed target-change type, numeric read time, target count and global flag.
The second observes the existing LocalStore outdated-update discard branch. It
copies incoming/current room/match revisions, timestamp seconds/nanos, comparison
sign and found-document booleans. Equal-version duplicates, equal timestamps
carrying newer game revisions, and older timestamps carrying newer game revisions
have separate counters. Timestamp strings are
validated and converted without losing nanosecond precision.

Each page retains at most 256 sanitized events, fixed saturating category counts,
an overflow count, and integer sequence/monotonic elapsed time. It never retains
documents, keys, document/target/stream IDs, URLs, tokens, payloads, raw responses
or messages. Recording is nonthrowing, never enables debug logging, and preserves
the original SDK expressions, comparisons, callbacks, log levels and errors.
Success and failure artifacts include this trace alongside listener history.
A completed-match snapshot is also captured before the final reload, which
otherwise resets each page's diagnostic history.

This is explicitly diagnostic SDK instrumentation in a test-only response, not
an unchanged-SDK execution claim. Game/app/transport sources remain unchanged;
real Auth, Functions and Firestore connections remain native loopback emulator
traffic. These observations do not establish live service or App Check behavior.
