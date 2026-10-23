// Preparation only. A reviewed current-state fingerprint cannot authorize writes.
import { FUNCTION_NAMES } from './prepare-floating-garden-trial.mjs';
import { ACTIVE_UPDATE_SCOPE as S, dataDigest, requireActiveUpdate as need } from './floating-garden-active-update.mjs';
import { isDeepStrictEqual } from 'node:util';
export const MIXED_RECOVERY_ASSIGNMENT = Object.freeze(FUNCTION_NAMES.map((name, index) => Object.freeze({ name, source: index === 0 ? 'next' : 'previous' })));
export function validateMixedAssignment(assignment) {
  need(isDeepStrictEqual(assignment, MIXED_RECOVERY_ASSIGNMENT), 'source-proof'); return structuredClone(assignment);
}
export function mixedRecoveryCandidate({ plan, assignment, capture, capturedAtMillis }) {
  validateMixedAssignment(assignment);
  need(plan && ['oldManifestDigest', 'newManifestDigest'].every(k => typeof plan[k] === 'string' && /^[a-f0-9]{64}$/.test(plan[k])) &&
    capture && typeof capture === 'object' && capture.data && capture.proof && capture.settings, 'source-proof');
  need(Number.isSafeInteger(capturedAtMillis) && capturedAtMillis >= S.startsAtMillis && capturedAtMillis < S.endsAtMillis, 'fixed-window');
  const binding = { schemaVersion: 1, purpose: 'mixed-source-read-only-review', oldManifestDigest: plan.oldManifestDigest, newManifestDigest: plan.newManifestDigest,
    sourceAssignment: MIXED_RECOVERY_ASSIGNMENT, capturedAtMillis, endsAtMillis: S.endsAtMillis,
    scope: Object.freeze({ project: S.project, region: S.region, maxRooms: S.maxRooms, existingRooms: 2, testerCount: 2 }),
    currentEvidenceFingerprint: dataDigest(capture), historicalPreservation: 'unknown', executionAllowed: false };
  return Object.freeze({ ...binding, fingerprint: dataDigest(binding) });
}
export function validateMixedRecoveryReview(candidate, review, now) {
  need(candidate && Object.getPrototypeOf(candidate) === Object.prototype, 'approval-required');
  const { fingerprint, ...binding } = candidate;
  need(/^[a-f0-9]{64}$/.test(fingerprint || '') && fingerprint === dataDigest(binding) &&
    Object.keys(binding).sort().join(',') === ['schemaVersion','purpose','oldManifestDigest','newManifestDigest','sourceAssignment','capturedAtMillis','endsAtMillis','scope','currentEvidenceFingerprint','historicalPreservation','executionAllowed'].sort().join(',') &&
    binding.schemaVersion === 1 && binding.purpose === 'mixed-source-read-only-review' &&
    ['oldManifestDigest', 'newManifestDigest', 'currentEvidenceFingerprint'].every(k => /^[a-f0-9]{64}$/.test(binding[k] || '')) &&
    isDeepStrictEqual(binding.scope, { project: S.project, region: S.region, maxRooms: S.maxRooms, existingRooms: 2, testerCount: 2 }) &&
    binding.endsAtMillis === S.endsAtMillis && Number.isSafeInteger(binding.capturedAtMillis) &&
    binding.capturedAtMillis >= S.startsAtMillis && binding.capturedAtMillis < S.endsAtMillis, 'approval-required');
  validateMixedAssignment(binding.sourceAssignment);
  need(candidate?.executionAllowed === false && candidate.historicalPreservation === 'unknown', 'approval-required');
  need(Number.isSafeInteger(now) && now >= candidate.capturedAtMillis && now - candidate.capturedAtMillis <= 5 * 60 * 1000 && now < S.endsAtMillis, 'fixed-window');
  need(isDeepStrictEqual(review, { schemaVersion: 1, purpose: 'mixed-source-read-only-review', candidateFingerprint: candidate.fingerprint,
    acknowledgeHistoricalPreservationUnknown: true, executionAllowed: false }), 'approval-required');
  return Object.freeze({ kind: 'review-bound', candidateFingerprint: candidate.fingerprint, executionAllowed: false });
}
