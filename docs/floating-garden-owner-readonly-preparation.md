# Owner read-only route preparation

This is an additional local source preparation. The previously delivered mixed
preflight remains frozen. No source has been published, no owner command handed
off, and no live credentials, cloud APIs, IAM, trust, deployment or reopening have
been exercised. The existing CI route stays pinned to its original SDK568 policy.

## Explicit API and trust boundary

`prepareOwnerReadonlyPreflight` is an API entry, not a command-line handoff. Its
default/plan mode returns immediately without filesystem, SDK or network work.
Only explicit `inspect-owner-readonly` mode starts the separately branded route.
The owner policy cannot satisfy the CI policy. Owner-branded provider and adapter
instances reject every mutation entrance before I/O, including before inspection,
after failure and after successful review. No transport or ADC client is created.

A future caller must supply the separately reviewed SHA256 of every one of the
seven original successful run5 renewal-journal files in the fixed private HOME
location. Each file is checked before parsing, against owned/no-symlink/private
file and directory identities. Before/after, plan digest, exact run4-to-run5 change
and all four successful status records must agree. Pins must come from independent
review, not be generated from those same files and automatically accepted. This
route never edits the existing journals. It does not establish a missing run5
pre-update full Function/Run/configuration baseline.

The active human account must hash to that journal's owner identity. SDK587 config,
project identity and active owner are read before obtaining an existing token. The
fixed project/billing flags select the intended target; they do not prove what the
user's ambient saved default project was. Later SDK commands explicitly pin that
checked owner with `--account`, so the final identity check confirms the selected
owner rather than promising that the ambient active default never changed. Config
is rechecked immediately before each metadata/token command; impersonation,
credential overrides, proxy/TLS/endpoints, debug logging and CI credentials stop the
route. The normal SDK CloudShell metadata discovery path is preserved.

Only fixed metadata argv are allowed. The trusted official installed SDK path and
reported version are checked, but the entire installed SDK tree is not hash-pinned;
a trusted official installation is a precondition. Child processes receive a finite
4096-line NO input buffer, not a continuous responder, and never `--quiet`. EOF or a
timeout stops work. The SDK may refresh credentials or update local credential
caches in a future live run. This is cloud read-only, not a claim of no SDK-local
filesystem effects. No login, auth changes, installation or credential persistence
is requested by this code. Tokens are held only in memory, never printed, returned
or added to evidence, and cleared on both success and failure.

## Fixed cloud reads and proof

The bounded HTTPS client permits only the exact Functions inventory/IAM, validated
Run identities, generation-pinned source objects in the existing fixed source
bucket, old Rules, existing Hosting site/live channel, Auth/AppCheck metadata, and
the fixed Firestore read surface. No SecretVersion payload access is available.
Functions inventory rejects pagination, unreachable regions and foreign/duplicate
resources. Run service identities must be unique across all five functions. ZIP
file inventories and contents are verified against the reviewed packets; a storage
generation is never equated with a commit. The latest/version1 distinction and all
existing current configuration, IAM, data, traffic and deadline checks remain.

Hosting metadata uses the same checked owner token, rather than an independent
Firebase CLI login. Public hosted bytes use only fixed manifest paths on the exact
origin, without the bearer token. Public redirects are manual so the expected root
302 can be verified; authenticated redirects are forbidden.

Firestore permits only fixed root-collection discovery and four read-only
transactions. Queries use the original six roots and two room collection groups,
fixed limits, and the exact in-memory transaction returned by beginTransaction.
No commit, batchWrite, transform, mutation method or read-write transaction exists.
Unknown roots, pagination, duplicate/foreign document paths and unsupported lossy
value encodings stop the read. Timestamp nanoseconds and negative-zero doubles
remain exact. Transaction rollback closes read-only transactions without data writes.

The owner result adds a fingerprint over the complete existing mixed candidate,
the independently pinned owner journal and an owner-identity attestation. Explicit
`validateOwnerReadonlyReview` binds all of these together without revealing the
owner email. It preserves the five-minute candidate limit and unknown historical
preservation statement. Every result remains `executionAllowed: false`; no review
unlocks writes or proves the cloud will remain unchanged after capture.

## Evidence and remaining limits

The entry creates one fresh fixed-name private 0700 directory under verified HOME,
then reuses the exclusive/fsynced 0600 structural-evidence store. Existing captures
are never reused or overwritten. Paths, ownership and filesystem identities are
verified; this does not prove the backing disk will persist or provide a retention
guarantee. The original SDK may still write its own credential cache as noted above.

Evidence contains per-store HMAC structural commitments, not reconstructable raw
provider snapshots. All scalar values and unknown keys are concealed. The key stays
in memory, so comparisons work only between records in the same evidence-store
session, not with a fresh later capture. Future live use still needs separate
approval, independently reviewed inputs, a reviewed retention destination and an
actual authentication/access check. Recovery deployment additionally needs its own
exact source/run approval and execution design. None is supplied by source testing.

## Offline qualification

Node tests use injected SDK/HTTP/Firestore responses and real old/new packet ZIP
validation. The successful renewal-journal fixture is generated by the existing
Python renewal helper with entirely synthetic cloud responses.

`tests/floating-garden-owner-readonly-sdk587.test.py` requires an already installed
trusted `--sdk-root`. It does not install an SDK. It runs the real SDK587 parser,
command/request/display machinery with synthetic transport and metadata only.
The isolated synthetic environment, including SDK config, is a test fixture; the
owner entry itself does not strip or replace the user's environment. Socket/DNS,
subprocess, credential-loader and credential-cache boundaries are guarded.

The recorded qualification covered 27 commands, 18 synthetic HTTP requests, 7 synthetic
metadata reads, 6 override-rendering cases and 6 deliberate denied-boundary probes.
The token command uses a synthetic credential-loader replacement. It qualifies argv,
selected account and output shape only: live credentials, refresh, RAB/cache behavior,
authenticated HTTP, permissions and live CloudShell behavior remain untested.
Optional Functions-list tests demonstrate why raw REST must retain and inspect the
full inventory envelope: `--verbosity=error` suppresses SDK unreachable warnings.
No SDK587 deployment qualification is claimed.
