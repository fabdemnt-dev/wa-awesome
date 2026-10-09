// API entry only. Default mode is inert; no command-line handoff is included.
// Preparing this source does not authorize a live owner inspection or recovery.
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareActiveUpdatePlan, activeUpdatePackets, dataDigest } from './floating-garden-active-update.mjs';
import { createActiveUpdateProvider } from './floating-garden-active-update-provider.mjs';
import { createPrivateEvidence } from './floating-garden-active-update-evidence.mjs';
import { MIXED_RECOVERY_ASSIGNMENT, validateMixedRecoveryReview } from './floating-garden-active-update-mixed-recovery.mjs';
import { ownerDigest, checkedOwnerHome, loadOwnerJournal, createOwnerReadonlyPolicy, ownerNeed as need, ownerGuard } from './floating-garden-owner-readonly-policy.mjs';
import { createOwnerReadonlyClients } from './floating-garden-owner-readonly-clients.mjs';
export const OWNER_CAPTURE_NAME = '.garden-owner-readonly-preflight-20261009';
export async function prepareOwnerReadonlyPreflight(options = {}) {
  if (options.mode === undefined || options.mode === 'plan') return Object.freeze({ mode: 'plan', cloudReads: 0, cloudWrites: 0, executionAllowed: false });
  let clients;
  try {
    need(options.mode === 'inspect-owner-readonly');
    const { env = process.env, execArgv = process.execArgv, now = Date.now, previousOutput, nextOutput, gcloudPath, journalPins,
      spawn, fetchImpl } = options;
    const home = checkedOwnerHome(env.HOME), journal = loadOwnerJournal({ home, pins: journalPins });
    const policy = createOwnerReadonlyPolicy({ env, ownerHash: journal.ownerHash, now, execArgv });
    const plan = await prepareActiveUpdatePlan({ previousOutput, nextOutput });
    const packets = activeUpdatePackets(plan);
    const paths = new Set(['/']);
    for (const packet of [packets.old.packet, packets.next.packet]) for (const path of Object.keys(packet.manifest.files)) {
      if (path.startsWith('game/public/')) paths.add('/' + path.slice('game/public/'.length));
    }
    const captureDirectory = join(home, OWNER_CAPTURE_NAME);
    // Fresh private HOME destination only. Existing captures are never reused,
    // overwritten, deleted, or treated as a successful current read.
    await mkdir(captureDirectory, { mode: 0o700 });
    const stat = await lstat(captureDirectory);
    need(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700 && await realpath(captureDirectory) === captureDirectory);
    const evidence = await createPrivateEvidence(captureDirectory);
    journal.recheck();
    clients = await createOwnerReadonlyClients({ policy, env, execArgv, gcloudPath, publicPaths: [...paths], now, ...(spawn ? { spawn } : {}), ...(fetchImpl ? { fetchImpl } : {}) });
    const provider = createActiveUpdateProvider({ plan, ownerReadonlyPolicy: policy, env, execArgv, now,
      runner: clients.runner, requestClient: clients.requestClient, db: clients.db, fetchImpl: clients.fetchPublic });
    const result = await provider.inspectMixedRecovery({ assignment: MIXED_RECOVERY_ASSIGNMENT, evidenceStore: evidence });
    clients.recheckIdentity(); journal.recheck();
    const envelope = { schemaVersion: 1, kind: 'owner-readonly-candidate', candidate: result.candidate,
      ownerJournalFingerprint: journal.journalFingerprint,
      ownerIdentityAttestation: ownerDigest({ ownerHash: journal.ownerHash, journalFingerprint: journal.journalFingerprint }),
      cloudWrites: 0, executionAllowed: false };
    return Object.freeze({ ...envelope, fingerprint: dataDigest(envelope) });
  } catch { throw ownerGuard(); }
  finally { clients?.close(); }
}

export function validateOwnerReadonlyReview(envelope, review, now) {
  try {
    need(envelope && typeof envelope === 'object'); const { fingerprint, ...binding } = envelope;
    need(Object.keys(binding).sort().join(',') === ['schemaVersion','kind','candidate','ownerJournalFingerprint','ownerIdentityAttestation','cloudWrites','executionAllowed'].sort().join(',') &&
      binding.schemaVersion === 1 && binding.kind === 'owner-readonly-candidate' && binding.cloudWrites === 0 && binding.executionAllowed === false &&
      ['ownerJournalFingerprint','ownerIdentityAttestation'].every(k => /^[a-f0-9]{64}$/.test(binding[k] || '')) && /^[a-f0-9]{64}$/.test(fingerprint || '') && fingerprint === dataDigest(binding));
    need(review && Object.keys(review).sort().join(',') === ['schemaVersion','purpose','ownerFingerprint','acknowledgeHistoricalPreservationUnknown','executionAllowed'].sort().join(',') &&
      review.schemaVersion === 1 && review.purpose === 'owner-readonly-review' && review.ownerFingerprint === fingerprint &&
      review.acknowledgeHistoricalPreservationUnknown === true && review.executionAllowed === false);
    validateMixedRecoveryReview(binding.candidate, { schemaVersion: 1, purpose: 'mixed-source-read-only-review',
      candidateFingerprint: binding.candidate.fingerprint, acknowledgeHistoricalPreservationUnknown: true, executionAllowed: false }, now);
    return Object.freeze({ kind: 'owner-review-bound', ownerFingerprint: fingerprint, executionAllowed: false });
  } catch { throw ownerGuard(); }
}
