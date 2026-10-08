# Run-3 provider trust renewal (owner only)

This is a prepared local recovery step, **not evidence of an executed renewal,
published commit, successful token exchange, deployment, or Garden readiness**.
The new reviewed release commit is not known yet. Do not substitute the old SHA,
a branch name, an abbreviated SHA, or the synthetic SHA used by tests.

## Exact scope

- Existing project: `wa-awesome-garden-stg` (`120030709276`).
- Existing pool/provider: `garden-github` / `wa-awesome-release`.
- Change only the provider's `attributeCondition`: exact `workflow_sha`
  `74027567a8761e78423c8df0e744abc8d5633a8b` → the separately reviewed new
  40-character lowercase commit SHA; exact `run_number` `2` → `3`.
- Keep repository/owner IDs, release ref, workflow path, `push`, `garden-trial`,
  and `run_attempt == '1'` constraints byte-for-byte; keep issuer, audience,
  mapping, enabled states, service accounts, roles and every IAM binding.
- The original deadline stays **2026-10-11T23:45:51.472Z** (`1791762351472`).
  Nothing renews that deadline. Existing IAM expiry guards are checked, not edited.

The original `setup-floating-garden-ci-owner.py` intentionally rejects a
mismatched existing provider (`provider_collision`). **Do not rerun setup as a
renewal mechanism**, delete/recreate federation, add a broad claim, grant another
role, or extend an expiry to work around that rejection.

## Before running

1. Obtain explicit owner approval for this exact trust change and the reviewed
   new commit. Code preparation or publication alone does not approve this
   security change. Separately verify that the next intended workflow run is
   run 3 / attempt 1 and that it will execute exactly that reviewed commit.
2. Download/check out both scripts from that exact commit, preserving their
   sibling paths. Use the authenticated repository's commit-specific download
   or a detached Git worktree for the reviewed full SHA. Do not use a moving
   branch download, `curl | python`, or execute a partially downloaded file.
   Compare local bytes with that commit's repository blobs before execution.
   Record the verified commit and both SHA-256 values for owner review.
3. The unchanged setup dependency must have SHA-256
   `8a4c2a4a4fc2725b19ec2159766559bed120e11e9c8605933661b11dddef77b5`.
   The renewal helper checks that hash before importing its metadata-only
   collector/validator and guarded process runner. Importing it does not run
   setup. No permission catalog scan or setup mutation planner is used.
4. Use the already installed official **gcloud 568.0.0**, with the existing
   signed-in owner. The helper does not install, log in, create credentials,
   impersonate, print tokens, or access secret payloads. Invalid identity,
   endpoint/credential overrides, incomplete metadata, unexpected federation,
   missing original grants, or changed expiry stop execution.
5. Ensure nobody else is editing this provider or its inspected IAM during the
   operation. IAM provider PATCH has no compare-and-swap/etag precondition.
   Fresh revalidation minimizes the race but cannot eliminate concurrent edits.

## Plan and owner execution

Default mode and `--plan` are completely offline and make no cloud calls:

```sh
python3 -I scripts/renew-floating-garden-ci-trust-owner.py --plan
```

After replacing `REVIEWED_NEW_40_HEX_COMMIT` with the independently verified
commit, the separately authorized owner can run the following in their terminal.
The placeholder is intentionally invalid. Choose a new private state directory
for each attempt; existing state is never overwritten.

```sh
python3 -I scripts/renew-floating-garden-ci-trust-owner.py --renew \
  --project wa-awesome-garden-stg \
  --project-number 120030709276 \
  --original-expiry 1791762351472 \
  --approved-release-sha REVIEWED_NEW_40_HEX_COMMIT \
  --approved-release-run-number 3 \
  --state-dir "$HOME/garden-run3-trust-renewal-UNIQUE"
```

The helper reads the actual state, displays both complete conditions and a plan
bound to the inspected metadata, and requires `RENEW <full plan SHA-256>` typed
exactly at its interactive prompt. There is no `--yes` or unattended mode.
Approval expires after five minutes, including the fresh metadata pass.

After approval, it durably saves a private before-snapshot and plan, re-reads
and revalidates immediately before dispatch, records an uncertainty marker,
and invokes exactly one `gcloud ... providers update-oidc` command supplying
only `--attribute-condition` as a mutation option. Both reads and the update
feed NO to unexpected SDK prompts, including API-enablement prompts.

The stock SDK may retry HTTP transport failures internally. The helper does
not retry a mutation command, roll back, or repair other state. The SDK contract
test captures `updateMask=attributeCondition`; SDK 568 also serializes its
default `disabled:false`, but that field is excluded from the update mask and
is not applied. This follows the [provider PATCH update-mask contract](https://cloud.google.com/iam/docs/reference/rest/v1/projects.locations.workloadIdentityPools.providers/patch)
and the [official update-oidc command](https://cloud.google.com/sdk/gcloud/reference/iam/workload-identity-pools/providers/update-oidc).

## Readback and uncertainty

- Success requires a fresh complete snapshot equal to the before-snapshot with
  only the intended `attributeCondition` replaced. The after-snapshot is saved.
- An already exact intended new-SHA/run-3 state is a no-op only after two matching
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
optional SDK-568 suite uses the real parser, request builder and serialization
against a synthetic HTTP transport. It blocks credentials, real network,
subprocesses and installation. Neither suite proves live permissions or token
exchange, and neither mutates cloud resources.
