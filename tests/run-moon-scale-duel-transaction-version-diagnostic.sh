#!/usr/bin/env bash
set -u

version_label="$1"
cli_version="$2"
case_name="$3"
test_file="$4"
test_pattern="$5"

artifact_root="diagnostic-artifacts/${version_label}/${case_name}"
work_root="diagnostic-work/${version_label}/${case_name}"
cache_root="diagnostic-work/${version_label}/emulator-cache"
mkdir -p "$artifact_root" "$work_root" "$cache_root"
rm -f firestore-debug.log functions-debug.log database-debug.log ui-debug.log

if [ "$cli_version" = "current" ]; then
  firebase_cli=(npx firebase)
else
  firebase_cli=(npx --yes "firebase-tools@${cli_version}")
fi

started_at=$(date +%s)
set -o pipefail
FIREBASE_EMULATORS_PATH="$cache_root" "${firebase_cli[@]}" \
  --config firebase.moon-scale-duel-emulator.json emulators:exec \
  --only auth,firestore,database,functions --project demo-moon-scale-duel \
  "node --test --test-force-exit --test-name-pattern='${test_pattern}' ${test_file}" \
  >"$work_root/full-output.log" 2>&1
exit_code=$?
finished_at=$(date +%s)
set +o pipefail

sed -E \
  -e 's/[0-9a-f]{8}-[0-9a-f-]{27,}/[REDACTED_ID]/gi' \
  -e 's/MSD1-[0-9A-HJKMNP-TV-Z-]+/[REDACTED_INVITE]/g' \
  -e 's/[A-Za-z0-9_-]{24,}/[REDACTED_VALUE]/g' \
  -e 's/(Bearer|token|authorization)([=: ]+)[^ ]+/\1\2[REDACTED]/gi' \
  "$work_root/full-output.log" \
  | grep -E '^(DIAGNOSTIC |ok |not ok |# Subtest:|# tests |# pass |# fail |# skipped |# duration_ms |.*(INVALID_ARGUMENT|Transaction is invalid or closed|Transaction lock timeout))' \
  >"$artifact_root/test-output.log" || true

if [ -f firestore-debug.log ]; then
  grep -Ei 'transaction|lock|retry|timeout|invalid|closed' firestore-debug.log \
    | sed -E \
      -e 's/[0-9a-f]{8}-[0-9a-f-]{27,}/[REDACTED_ID]/gi' \
      -e 's/[A-Za-z0-9_-]{24,}/[REDACTED_VALUE]/g' \
    >"$artifact_root/firestore-transaction-events.log" || true
fi

if [ -f functions-debug.log ]; then
  grep -Ei 'moonScaleDuelSubmitCard|INVALID_ARGUMENT|Transaction is invalid or closed|error' functions-debug.log \
    | sed -E \
      -e 's/[0-9a-f]{8}-[0-9a-f-]{27,}/[REDACTED_ID]/gi' \
      -e 's/MSD1-[0-9A-HJKMNP-TV-Z-]+/[REDACTED_INVITE]/g' \
      -e 's/[A-Za-z0-9_-]{24,}/[REDACTED_VALUE]/g' \
      -e 's/(Bearer|token|authorization)([=: ]+)[^ ]+/\1\2[REDACTED]/gi' \
    >"$artifact_root/functions-events.log" || true
fi

lock_timeouts=$(grep -Eic 'Transaction lock timeout' "$artifact_root/firestore-transaction-events.log" 2>/dev/null || true)
invalid_closed=$(grep -Eic 'Transaction is invalid or closed' "$artifact_root"/*.log 2>/dev/null || true)
invalid_argument=$(grep -Eic 'INVALID_ARGUMENT' "$artifact_root"/*.log 2>/dev/null || true)

jq -n \
  --arg version "$version_label" \
  --arg caseName "$case_name" \
  --arg cliVersion "$cli_version" \
  --argjson exitCode "$exit_code" \
  --argjson elapsedSeconds "$((finished_at - started_at))" \
  --argjson lockTimeouts "${lock_timeouts:-0}" \
  --argjson invalidClosed "${invalid_closed:-0}" \
  --argjson invalidArgument "${invalid_argument:-0}" \
  '{version:$version,case:$caseName,cliVersion:$cliVersion,exitCode:$exitCode,elapsedSeconds:$elapsedSeconds,lockTimeouts:$lockTimeouts,invalidClosed:$invalidClosed,invalidArgument:$invalidArgument}' \
  >"$artifact_root/case-summary.json"

exit 0
