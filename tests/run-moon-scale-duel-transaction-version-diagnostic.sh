#!/usr/bin/env bash
set -u

version_label="$1"; cli_version="$2"; emulator_version="$3"; case_name="$4"
test_file="$5"; test_pattern="$6"; trials_expected="$7"
repo_root="$(pwd)"
artifact_root="$repo_root/diagnostic-artifacts/$version_label/$case_name"
work_root="$repo_root/diagnostic-work/$version_label/$case_name"
cache_root="$repo_root/diagnostic-work/$version_label/emulator-cache"
mkdir -p "$artifact_root" "$work_root" "$cache_root"
rm -f firestore-debug.log functions-debug.log database-debug.log ui-debug.log

if [ "$cli_version" = 14.27.0 ]; then firebase_cli=(npx firebase); else firebase_cli=(npx --yes "firebase-tools@$cli_version"); fi
sanitize() {
  sed -E -e 's/[0-9a-f]{8}-[0-9a-f-]{27,}/[REDACTED_ID]/gi' \
    -e 's/MSD1-[0-9A-HJKMNP-TV-Z-]+/[REDACTED_INVITE]/g' \
    -e 's/(roomId|inviteCode|cardId|copyTarget|token|authorization)([=: ]+)[^ ,}]*/\1\2[REDACTED]/gi' \
    -e 's/(Bearer +)[^ ]+/\1[REDACTED]/gi' -e 's/[A-Za-z0-9_-]{32,}/[REDACTED_VALUE]/g'
}

set +e
"${firebase_cli[@]}" --version >"$work_root/cli-version.stdout" 2>"$work_root/cli-version.stderr"
cli_exit=$?
set -e
actual_cli_version="$(tr -d '\r\n ' <"$work_root/cli-version.stdout")"
cli_available=false; cli_version_matches=false
[ "$cli_exit" -eq 0 ] && cli_available=true
[ "$actual_cli_version" = "$cli_version" ] && cli_version_matches=true

started_ms="$(date +%s%3N)"
set +e
FIREBASE_EMULATORS_PATH="$cache_root" "${firebase_cli[@]}" --config firebase.moon-scale-duel-emulator.json \
  emulators:exec --only auth,firestore,database,functions --project demo-moon-scale-duel \
  "node --test --test-force-exit --test-name-pattern='${test_pattern}' ${test_file}" \
  >"$work_root/full-output.log" 2>&1
exit_code=$?
set -e
finished_ms="$(date +%s%3N)"; elapsed_ms=$((finished_ms - started_ms))

sanitize <"$work_root/full-output.log" | grep -Ei 'DIAGNOSTIC|Subtest:|tests |pass |fail |skipped |duration_ms|emulator|functions definitions|loaded|module|transaction|error|failed|warning' | head -n 2000 >"$artifact_root/preparation-and-test.log" || true
sanitize <"$work_root/cli-version.stderr" | head -n 100 >"$artifact_root/cli-stderr.log"
if [ -f firestore-debug.log ]; then sanitize <firestore-debug.log | grep -Ei 'transaction|lock|retry|timeout|invalid|closed|error|warning' | head -n 4000 >"$artifact_root/firestore-emulator.log" || true; fi
if [ -f functions-debug.log ]; then sanitize <functions-debug.log | grep -Ei 'Loaded functions definitions|moonScaleDuelSubmitCard|invalid|closed|error|warning' | head -n 4000 >"$artifact_root/functions-emulator.log" || true; fi

firestore_started=false; functions_started=false; function_definitions_loaded=false; test_module_loaded=false
grep -Eq 'Firestore Emulator logging|firestore: .*running|All emulators ready' "$work_root/full-output.log" && firestore_started=true
grep -Eq 'functions: (Watching|Loaded functions definitions)|All emulators ready' "$work_root/full-output.log" && functions_started=true
grep -Eq 'Loaded functions definitions.*moonScaleDuelSubmitCard|moonScaleDuelSubmitCard.*Loaded functions definitions' "$work_root/full-output.log" && function_definitions_loaded=true
grep -Eq 'DIAGNOSTIC |# Subtest:|Subtest:' "$work_root/full-output.log" && test_module_loaded=true

callback_attempts_total="$(grep -Eo '"attempts":[0-9]+' "$work_root/full-output.log" 2>/dev/null | cut -d: -f2 | awk '{s+=$1} END {print s+0}')"
if [ "$callback_attempts_total" -eq 0 ]; then callback_attempts_total="$(grep -Ec 'Beginning execution of .*moonScaleDuelSubmitCard' "$work_root/full-output.log" 2>/dev/null || true)"; fi
if [ "$callback_attempts_total" -eq 0 ] && [ "$exit_code" -eq 0 ] && [ "$test_module_loaded" = true ]; then callback_attempts_total=1; fi
trials_started="$(grep -Ec '^DIAGNOSTIC .*"trial":[0-9]+' "$work_root/full-output.log" 2>/dev/null || true)"
trials_succeeded="$(grep -Ec '^DIAGNOSTIC .*"result":"success"' "$work_root/full-output.log" 2>/dev/null || true)"
trials_failed="$(grep -Ec '^DIAGNOSTIC .*"result":"failure"' "$work_root/full-output.log" 2>/dev/null || true)"
if [ "$case_name" = six-rounds ] || [ "$case_name" = readiness ]; then trials_started=1; if [ "$exit_code" -eq 0 ]; then trials_succeeded=1; trials_failed=0; else trials_succeeded=0; trials_failed=1; fi; fi
lock_timeouts="$(grep -Eh '^WARNING: Operation failed: Transaction lock timeout\.$' "$artifact_root"/*.log 2>/dev/null | wc -l | tr -d ' ')"
invalid_closed="$(grep -Eh 'Transaction is invalid or closed' "$artifact_root"/*.log 2>/dev/null | sort -u | wc -l | tr -d ' ')"
invalid_argument="$(grep -Eh 'INVALID_ARGUMENT' "$artifact_root"/*.log 2>/dev/null | sort -u | wc -l | tr -d ' ')"
diagnostic_started=false; [ "$callback_attempts_total" -ge 1 ] && diagnostic_started=true
preparation_error=""
if [ "$diagnostic_started" = false ]; then preparation_error="$(grep -Ei 'error|failed|not found|unsupported|requires|cannot|could not' "$artifact_root/preparation-and-test.log" "$artifact_root/cli-stderr.log" 2>/dev/null | head -n 1 | cut -c1-300)"; [ -z "$preparation_error" ] && preparation_error='Transaction callback was not reached'; fi

jq -n --arg version "$version_label" --arg emulator_version "$emulator_version" --arg case "$case_name" \
  --arg actual_cli_version "$actual_cli_version" --arg preparation_error "$preparation_error" \
  --argjson cli_available "$cli_available" --argjson cli_version_matches "$cli_version_matches" \
  --argjson firestore_emulator_started "$firestore_started" --argjson functions_emulator_started "$functions_started" \
  --argjson function_definitions_loaded "$function_definitions_loaded" --argjson test_module_loaded "$test_module_loaded" \
  --argjson diagnostic_started "$diagnostic_started" --argjson callback_attempts_total "$callback_attempts_total" \
  --argjson trials_expected "$trials_expected" --argjson trials_started "$trials_started" --argjson trials_succeeded "$trials_succeeded" \
  --argjson trials_failed "$trials_failed" --argjson exit_code "$exit_code" --argjson lock_timeout_count "${lock_timeouts:-0}" \
  --argjson invalid_closed_count "${invalid_closed:-0}" --argjson invalid_argument_count "${invalid_argument:-0}" --argjson elapsed_ms "$elapsed_ms" \
  '{version:$version,emulator_version:$emulator_version,case:$case,actual_cli_version:$actual_cli_version,cli_available:$cli_available,cli_version_matches:$cli_version_matches,firestore_emulator_started:$firestore_emulator_started,functions_emulator_started:$functions_emulator_started,function_definitions_loaded:$function_definitions_loaded,test_module_loaded:$test_module_loaded,diagnostic_started:$diagnostic_started,callback_attempts_total:$callback_attempts_total,trials_expected:$trials_expected,trials_started:$trials_started,trials_succeeded:$trials_succeeded,trials_failed:$trials_failed,exit_code:$exit_code,lock_timeout_count:$lock_timeout_count,invalid_closed_count:$invalid_closed_count,invalid_argument_count:$invalid_argument_count,elapsed_ms:$elapsed_ms,preparation_error:$preparation_error}' >"$artifact_root/case-summary.json"
exit "$exit_code"
