# Read-only trust audit and run-4 renewal (owner only)

This is prepared owner tooling, **not evidence of an executed audit or renewal,
published commit, successful token exchange, deployment, or Garden readiness**.
The new reviewed release commit is not known yet. Do not substitute the old SHA,
a branch name, an abbreviated SHA, or the synthetic SHA used by tests.

## Exact scope

- Existing project: `wa-awesome-garden-stg` (`120030709276`).
- Existing pool/provider: `garden-github` / `wa-awesome-release`.
- Change only the provider's `attributeCondition`: exact `workflow_sha`
  `95ec4e69e4b566df91a37a4107e1a1fd94478ebf` → the separately reviewed new
  40-character lowercase commit SHA; exact `run_number` `3` → `4`.
- Keep repository/owner IDs, release ref, workflow path, `push`, `garden-trial`,
  and `run_attempt == '1'` constraints byte-for-byte; keep issuer, audience,
  mapping, enabled states, service accounts, roles and every IAM binding.
- The original deadline stays **2026-10-11T23:45:51.472Z** (`1791762351472`).
  Nothing renews that deadline. Existing IAM expiry guards are checked, not edited.

The original `setup-floating-garden-ci-owner.py` intentionally rejects a
mismatched existing provider (`provider_collision`). **Do not rerun setup as a
renewal mechanism**, delete/recreate federation, add a broad claim, grant another
role, or extend an expiry to work around that rejection.

## Run-4 preparation boundary

Run 3 / attempt 1 was consumed by a release that stopped during the closed-state
baseline traffic check, before deployment stages. Preparing or publishing this
run-4 source does not retry that run, renew trust, deploy, or reopen the Garden.
The release workflow requires an existing-branch push whose exact before-SHA is
`95ec4e69e4b566df91a37a4107e1a1fd94478ebf`, new event-after/workflow/source SHA all
match, and run 4 / attempt 1. Check refs and the latest workflow run again before
any separately approved release publication. Do not rerun a consumed attempt.

The live old provider condition is exactly **95ec/run 3**, not the legacy setup
condition. The helper checks that live condition (or the exact approved intended
new-SHA/run-4 condition) before consulting the original setup validator. That
immutable, hash-pinned validator still understands run 2. Only a private copied
snapshot's already-checked provider condition is projected to its original
74027567/run-2 representation; its fixed validation context is checked, every
other field is unchanged, and live data is never edited by the projection.
Old run-2 live trust is rejected rather than repaired or accepted as current.

The eventual deployment retains the existing closed baseline: two rooms and
created-room count 2, room cap 20, the same two testers, the same original expiry,
and the five-Functions/Rules/Hosting scope. Reopening remains conditional on
successful deployment, independent readback and data/IAM preservation checks.
Neither the renewal result nor a source/CI result proves those later checks.

## Before running

1. For `--audit`, review the source commit and request the read-only check.
   An audit neither approves nor performs a trust change. For `--renew`, obtain
   separate explicit owner approval for the exact trust change and reviewed
   release commit. Source preparation, publication, and a successful audit do
   not approve that security change or a release. Before renewal, separately
   verify the next intended workflow run is run 4 / attempt 1 at that commit.
2. Download/check out both scripts from that exact commit, preserving their
   sibling paths. Use the authenticated repository's commit-specific download
   or a detached Git worktree for the reviewed full SHA. Do not use a moving
   branch download, `curl | python`, or execute a partially downloaded file.
   Compare local bytes with that commit's repository blobs before execution.
   Record the verified commit and both SHA-256 values for owner review.
   The new tooling commit is only a potential future release commit after its
   exact-head checks and separate review/authorization. Do not run new helper
   bytes while labeling an older release SHA as their reviewed source. For the
   flow below, both script blobs and the supplied candidate SHA must identify
   the same reviewed full commit. A later commit requires a fresh review.
3. The unchanged setup dependency must have SHA-256
   `8a4c2a4a4fc2725b19ec2159766559bed120e11e9c8605933661b11dddef77b5`.
   The renewal helper checks that hash before importing its metadata-only
   collector/validator and guarded process runner. Importing it does not run
   setup. No permission catalog scan or setup mutation planner is used.
4. Use the already installed official **gcloud 568.0.0 or exactly 587.0.0**,
   with the existing signed-in owner. Other versions are rejected; there is no
   minimum-version bypass. Do not downgrade, install, or change the owner SDK
   for this flow. Owner-tool qualification for 587 does not qualify deployment
   with that SDK: the separate deployment workflow remains pinned to 568.0.0.
   The helper does not install, log in, create credentials,
   impersonate, print tokens, or access secret payloads. Invalid identity,
   endpoint/credential overrides, incomplete metadata, unexpected federation,
   missing original grants, or changed expiry stop execution.
   Preserve normal credential discovery in the existing Cloud Shell session.
   Do not force `CLOUDSDK_CORE_CHECK_GCE_METADATA=false` for authenticated owner
   reads: doing so can hide an existing metadata-backed signed-in owner. A
   separate SDK-info-only preflight may disable metadata discovery without
   passing that override to subsequent reads. Tests use synthetic credentials
   and intentionally disable discovery only inside their offline environment.
5. Ensure nobody else is editing this provider or its inspected IAM during the
   operation. IAM provider PATCH has no compare-and-swap/etag precondition.
   Fresh revalidation minimizes the race but cannot eliminate concurrent edits.

## Offline plan, then read-only audit

Default mode and `--plan` are completely offline and make no cloud calls:

```sh
python3 -I scripts/renew-floating-garden-ci-trust-owner.py --plan
```

After verifying both sibling scripts from the same reviewed full commit, replace
`REVIEWED_NEW_40_HEX_COMMIT` with that candidate commit. The placeholder is
intentionally invalid. The existing `--approved-release-sha` flag selects the
exact condition to inspect; supplying it in audit mode does not approve a write.

```sh
python3 -I scripts/renew-floating-garden-ci-trust-owner.py --audit \
  --project wa-awesome-garden-stg \
  --project-number 120030709276 \
  --original-expiry 1791762351472 \
  --approved-release-sha REVIEWED_NEW_40_HEX_COMMIT \
  --approved-release-run-number 4
```

`--audit` uses a separate read-only command boundary. It has no renewal writer,
confirmation prompt, setup planner, local raw snapshot files, or state directory.
It does not enable APIs, repair drift, log in, create credentials, change IAM,
access secret payloads, or deploy. As with ordinary signed-in metadata reads,
the existing SDK may refresh the owner's existing authentication session; this
is not an authentication/setup flow initiated by the helper.

The audit uses the **same complete baseline collector and validator** as renewal:
fixed project/number, existing APIs, exact five Functions and runtime/build
identities, raw source bucket ownership and policy, HMAC version metadata,
project/ancestor/resource IAM, accounts/keys, exact custom-role permissions,
original-expiry bindings, pool/provider, strict mapping/issuer/audience and
exact original or intended claim condition. It does two complete matching reads,
including pagination/incomplete-inventory checks; missing grants or any rejected
drift stops rather than being repaired. It does not scan the setup permission
catalog. Each SDK read still feeds NO to unexpected prompts.

Success prints only `TRUST_AUDIT_VERIFIED`, fixed scope/version/expiry, whether the
condition is `original` or `intended`, a snapshot digest, two matching reads,
`cloud_writes: 0`, and `release_ready: false`. No account identities or raw IAM
JSON are printed or saved. A stop prints a bounded diagnostic stage, not stderr.
An audit proves inspected metadata at those reads, not token exchange, future
immutability, live deploy permissions, or Garden readiness. Inspection uses the
actual SDK-rendered policy representation; some inherited IAM commands do not
explicitly request policy version 3. Offline coverage does not establish
exhaustive visibility of conditional fields for those APIs. Required original
conditional grants must still match the strict validator or the audit stops.
Keep private renewal
journals out of chat; only share the bounded audit result if troubleshooting.

## Separately approved renewal

The audit command above never advances automatically to this step. A new,
explicitly authorized owner invocation is required. Use the same reviewed
commit and choose a new private state directory; existing history is never
overwritten.

```sh
python3 -I scripts/renew-floating-garden-ci-trust-owner.py --renew \
  --project wa-awesome-garden-stg \
  --project-number 120030709276 \
  --original-expiry 1791762351472 \
  --approved-release-sha REVIEWED_NEW_40_HEX_COMMIT \
  --approved-release-run-number 4 \
  --state-dir "$HOME/garden-run4-trust-renewal-UNIQUE"
```

The helper reads the actual state, displays both complete conditions and a plan
bound to the inspected metadata, and requires `RENEW <full plan SHA-256>` typed
exactly at its interactive prompt. There is no `--yes` or unattended mode.
Read all plan expectations before launching. Copy the current prompt's `RENEW`
plus the complete plan hash without its final colon; do not use the snapshot
hash or an earlier prompt. Keep input/output attached to the terminal, never
pipe an approval or capture the interactive prompt behind a heredoc. Preserve
all old run-3 directories and use a fresh run-4 directory even after a stop.
Approval expires after five minutes, including the fresh metadata pass.

After approval, it durably saves a private before-snapshot and plan, re-reads
and revalidates immediately before dispatch, records an uncertainty marker,
and invokes exactly one `gcloud ... providers update-oidc` command supplying
only `--attribute-condition` as a mutation option. Both reads and the update
feed NO to unexpected SDK prompts, including API-enablement prompts.

The stock SDK may retry HTTP transport failures internally. The helper does
not retry a mutation command, roll back, or repair other state. The SDK contract
tests capture `updateMask=attributeCondition`; SDK 568 and 587 also serialize their
default `disabled:false`, but that field is excluded from the update mask and
is not applied. This follows the [provider PATCH update-mask contract](https://cloud.google.com/iam/docs/reference/rest/v1/projects.locations.workloadIdentityPools.providers/patch)
and the [official update-oidc command](https://cloud.google.com/sdk/gcloud/reference/iam/workload-identity-pools/providers/update-oidc).

## Readback and uncertainty

- Success requires a fresh complete snapshot equal to the before-snapshot with
  only the intended `attributeCondition` replaced. The after-snapshot is saved.
- An already exact intended new-SHA/run-4 state is a no-op only after two matching
  complete reads. Any other SHA, run, claim, setting, or incomplete setup fails.
- Any timeout, interruption, readback mismatch, or local-state failure stops.
  A dispatched mutation remains marked `possibly_applied` until exact readback
  and the durable final journal record succeed. Do not infer failure means the
  cloud rejected the write or immediately run it again.
- Inspect the private append-only `status-*.json` journal and reconcile the live
  provider before a separately authorized fresh attempt. Keep `before.json`,
  `plan.json`, and `after.json` (if present); no automatic restoration is supplied.
  These snapshots can contain private IAM identities. Keep them local/private;
  do not upload or paste them into logs, issues, or chat.
- `TRUST_METADATA_VERIFIED` or `TRUST_ALREADY_EXACT` always reports
  `release_ready=false`. Release execution and verification remain separate.

## Offline checks

```sh
python3 -I tests/floating-garden-ci-trust-renewal.test.py
python3 -I tests/floating-garden-ci-trust-renewal.test.py \
  --sdk-root /path/to/already-installed/google-cloud-sdk
```

The first suite forbids real processes and networking and tests exact-scope
changes, original-expiry IAM guards, backups, no-op behavior, stale approvals,
interrupted/uncertain outcomes, unexpected settings, and prompt rejection. The
optional exact-SDK-568/587 renewal suite uses the real parser, request builder
and serialization
against a synthetic HTTP transport. It blocks credentials, real network,
subprocesses and installation. The dedicated owner SDK 587 suite additionally
exercises every inherited read
command through the real parser/request builder and output rendering, including
paginated Functions and unreachable-region diagnostics, ancestor/resource IAM,
service-account keys, and raw Storage ownership metadata. Local config/account
inventory seams use synthetic data; no credentials are opened or refreshed.

```sh
python3 -I tests/floating-garden-ci-owner-sdk.test.py \
  --sdk-root /path/to/already-installed/google-cloud-sdk-587
```

CI runs the deployment proof on 568 separately from the owner-read and renewal
proofs on exactly 587. These are synthetic offline contract checks, not evidence
of live permissions or token exchange, and they do not mutate cloud resources.
