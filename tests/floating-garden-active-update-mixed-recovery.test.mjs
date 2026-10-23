import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVE_UPDATE_SCOPE as S, dataDigest } from '../scripts/floating-garden-active-update.mjs';
import { MIXED_RECOVERY_ASSIGNMENT, mixedRecoveryCandidate, validateMixedRecoveryReview } from '../scripts/floating-garden-active-update-mixed-recovery.mjs';
const args = () => ({ plan: { oldManifestDigest: 'a'.repeat(64), newManifestDigest: 'b'.repeat(64) }, assignment: structuredClone(MIXED_RECOVERY_ASSIGNMENT),
  capture: { data: { retainedDigest: 'synthetic' }, proof: { source: 'synthetic' }, settings: { state: 'synthetic' } }, capturedAtMillis: S.startsAtMillis + 10000 });
const review = candidate => ({ schemaVersion: 1, purpose: 'mixed-source-read-only-review', candidateFingerprint: candidate.fingerprint, acknowledgeHistoricalPreservationUnknown: true, executionAllowed: false });
function resign(candidate, patch) { const { fingerprint, ...binding } = { ...candidate, ...patch }; return { ...binding, fingerprint: dataDigest(binding) }; }
test('review rejects recomputed forged timestamps, scope, digest types and assignments', () => {
  const candidate = mixedRecoveryCandidate(args());
  for (const patch of [{ capturedAtMillis: String(candidate.capturedAtMillis) }, { capturedAtMillis: S.startsAtMillis - 1 }, { capturedAtMillis: S.endsAtMillis },
    { scope: { ...candidate.scope, maxRooms: 21 } }, { endsAtMillis: S.endsAtMillis + 1 }, { oldManifestDigest: 'bad' }, { executionAllowed: true },
    { sourceAssignment: [...candidate.sourceAssignment].reverse() }, { historicalPreservation: 'verified' }, { extra: true }]) {
    const forged = resign(candidate, patch); assert.throws(() => validateMixedRecoveryReview(forged, review(forged), S.startsAtMillis + 10000));
  }
  assert.throws(() => validateMixedRecoveryReview(candidate, review(candidate), S.startsAtMillis - 1));
});
test('candidate inputs reject bad packet identities, times and incomplete captures', () => {
  for (const patch of [{ plan: {} }, { plan: { oldManifestDigest: 'a'.repeat(40), newManifestDigest: 'b'.repeat(64) } },
    { capturedAtMillis: String(S.startsAtMillis) }, { capturedAtMillis: S.endsAtMillis }, { capturedAtMillis: S.startsAtMillis - 1 }, { capture: {} }]) {
    assert.throws(() => mixedRecoveryCandidate({ ...args(), ...patch }));
  }
});
test('current evidence drift changes the bound fingerprint and nested reviewed fields are immutable', () => {
  const a = mixedRecoveryCandidate(args()), changed = args(); changed.capture.settings.state = 'changed'; const b = mixedRecoveryCandidate(changed);
  assert.notEqual(a.fingerprint, b.fingerprint); assert.throws(() => validateMixedRecoveryReview(b, review(a), b.capturedAtMillis));
  assert.throws(() => { a.sourceAssignment[0].source = 'previous'; }); assert.throws(() => { a.scope.maxRooms = 21; });
  assert.equal(validateMixedRecoveryReview(a, review(a), a.capturedAtMillis).executionAllowed, false);
});
