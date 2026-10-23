# Mixed-source recovery preparation (local source only)

This change prepares a read-only preflight and better preservation diagnostics.
It does not resume the failed fifth release, authorize a sixth run, publish any
source, alter trust/IAM, change the original expiry, or reopen the trial. No new
CLI/owner command or workflow entry invokes this preflight.

## Bounded read-only preflight

`createActiveUpdateProvider().inspectMixedRecovery` accepts only the explicit
assignment CreateRoom = next reviewed packet, other four functions = previous
reviewed packet. A changed storage generation is never interpreted as a commit.
The existing adapters download the generation-pinned ZIPs and verify their exact
file inventories and bytes against the old/new reviewed packets. The complete
five-function inventory must match across both subset reads and across two full
rounds. Existing Function/Run readiness, traffic, invoker IAM, narrow configuration,
old Rules/Hosting proofs, closed gate, same two testers, two existing rooms, cap20,
data inventory and fixed expiry checks remain in force. Configured secret version
`1` is preserved exactly; the separate `latest` describe must resolve to enabled
version1 with exactly identical metadata.

Both rounds include full current Function/Run/IAM evidence, settings and retained
data fingerprints. This establishes current state only. The historical run5 full
baseline was not saved; no new capture reconstructs or approves it.

The result contains `candidate`, whose fingerprint binds packet manifest digests,
ordered assignments, complete current evidence (including source object identity),
scope, capture time and original expiry. `validateMixedRecoveryReview` accepts only
an explicit review naming that exact candidate and acknowledging unknown historical
preservation. It recomputes the fingerprint, checks fixed fields and limits age to
five minutes. It returns `executionAllowed: false`. It neither creates user approval
nor asserts that the cloud still equals a previously captured candidate.

Inspection latches the provider permanently read-only before input validation.
Successful inspection, failed reads, failed evidence persistence and review results
cannot populate the executable baseline or unlock any mutation method. A later
execution design must separately obtain explicit review of the current baseline,
revalidate current evidence, bind a newly approved source SHA/run and arrange evidence
retention. Nothing in this preparation supplies those approvals.

## Preservation diagnostics and local durability

Existing stable configuration projections and strict equality remain unchanged.
No additional output-only field is ignored. A mismatch now produces bounded fixed
field paths in the existing sanitized CI result. Unknown keys map to `$unknown`;
values, provider messages, dynamic keys, credentials, user IDs and URLs never appear.
Configuration equality is checked before its narrow validator during post-update
readback, so a concrete changed field can be identified while both checks still
block the next write.

CI journals also save a baseline and a checkpoint before each SDK mutation. Files
are exclusive0600 in a fresh0700 directory, with owned non-symlink parent validation,
file/directory fsync, inode/link/mode verification and exact readback. A persistence
failure prevents the corresponding SDK call and is never blindly retried. The
original deadline and environment are rechecked after asynchronous journal work.
A failed/uncertain SDK result still receives readback, remains blocked and cannot
retry or advance to the next function, Rules, Hosting or reopening.

These files contain structural HMAC commitments, not raw provider values. Known
field names are retained; unknown names and every scalar value are keyed commitments.
The random key is memory-only and never written. Comparisons are meaningful within
one capture, not across independent captures. The records cannot reconstruct a full
historical baseline. They are locally durable only and disappear with an ephemeral
GitHub runner; no artifact upload or workflow change is included. Fixed safe failure
paths survive in the existing sanitized result even when private records expire.

Future owner CloudShell private-HOME storage is one possible retention destination,
but adopting it changes execution/authentication routing and requires a separate
review and authorization. It is not selected or enabled here.

## Validation

All tests use injected SDK/HTTP/Firestore evidence and local generated ZIPs. No ADC,
cloud API call, deployment, owner command or repository publication is exercised.
Tests cover mixed assignment/ZIP content proof, whole-inventory and settings drift,
latest/version1 separation, explicit review mismatch/expiry, permanent mutation
locks, file/directory fsync failures, substitution/hardlink/symlink attacks, safe
unknown-field diagnostics, and no retry after a post-update preservation failure.
