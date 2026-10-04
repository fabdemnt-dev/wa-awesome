#!/usr/bin/env bash
# Owner-operated standard Firebase CLI recovery for the existing Garden packet.
# One Functions-only attempt after read-only checks. No gate/date/Rules/Hosting change.
# Normal Firebase output stays visible and in a private local log; never upload debug logs.
(
  set -o pipefail
  umask 077
  B="$HOME/garden-trial-f0bc4eb0"
  P=wa-awesome-garden-stg
  G=asia-northeast1
  D="$(mktemp -d "$HOME/garden-official-read.XXXXXX")" || exit 1
  curl --fail --silent --show-error --proto '=https' --max-time 180 'https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/94bd220a68be34a9497a81f5be37c8d027b214ec/scripts/start-floating-garden-trial-owner.py' -o "$D/read.py" || exit 1
  printf '%s  %s\n' '156ac6bdd5c86418d372ce415f5a926406d399dde39ecf3094f267eb81659c68' "$D/read.py" | sha256sum --check || exit 1
  S="$(python3 -I "$D/read.py" --diagnose-functions)" || exit 1
  printf '%s\n' "$S"
  if ! printf '%s\n' "$S" | grep -Fxq 'READ_ONLY_DONE' || ! printf '%s\n' "$S" | grep -Fxq 'ADMIN: stopped'; then echo 'STOP: stopped state not verified.'; exit 1; fi
  if ! printf '%s\n' "$S" | grep -Fxq 'JOURNAL: DEPLOY=failed:deploy-functions,STOP=new,create-stopped-admin:issued,create-stopped-admin:verified,deploy-functions:issued' || test -e "$B/operation/OPERATION.lock" || test -L "$B/operation/OPERATION.lock"; then echo 'STOP: expected failed attempt not verified.'; exit 1; fi
  if printf '%s\n' "$S" | grep -Fxq 'FUNCTIONS_VERIFY: VERIFIED'; then echo 'BACKEND_ALREADY_VERIFIED: no deployment performed.'; exit 0; fi
  export CLOUDSDK_CORE_DISABLE_PROMPTS=true CLOUDSDK_CORE_LOG_HTTP=false CLOUDSDK_CORE_DISABLE_FILE_LOGGING=true
  F="$(gcloud functions list --project="$P" --billing-project="$P" --v2 --regions="$G" --format=json --verbosity=error)" || exit 1
  R="$(gcloud run services list --project="$P" --billing-project="$P" --region="$G" --platform=managed --format=json --verbosity=error)" || exit 1
  if ! printf '%s' "$F" | python3 -I -c 'import json,sys; assert json.load(sys.stdin)==[]' 2>/dev/null || ! printf '%s' "$R" | python3 -I -c 'import json,sys; assert json.load(sys.stdin)==[]' 2>/dev/null; then echo 'STOP: Tokyo resources present or inventory unverified; no deployment.'; exit 1; fi
  A="$(gcloud services list --enabled --project="$P" --billing-project="$P" --format=json --verbosity=error)" || exit 1
  if ! printf '%s' "$A" | python3 -I -c 'import json,sys; v=json.load(sys.stdin); assert type(v)==list; have={x["config"]["name"] for x in v}; assert {x+".googleapis.com" for x in "cloudfunctions cloudbuild artifactregistry run eventarc pubsub storage secretmanager".split()}<=have' 2>/dev/null; then echo 'STOP: existing deployment APIs not verified.'; exit 1; fi
  I="$(gcloud secrets get-iam-policy FLOATING_GARDEN_INVITE_HMAC_KEY --project="$P" --billing-project="$P" --format=json --verbosity=error)" || exit 1
  if ! printf '%s' "$I" | python3 -I -c 'import json,sys; p=json.load(sys.stdin); assert any(b.get("role")=="roles/secretmanager.secretAccessor" and not b.get("condition") and "serviceAccount:garden-trial-runtime@wa-awesome-garden-stg.iam.gserviceaccount.com" in b.get("members",[]) for b in p["bindings"])' 2>/dev/null; then echo 'STOP: existing runtime secret access not verified.'; exit 1; fi
  CLI="$B/tooling/node_modules/firebase-tools/lib/bin/firebase.js"
  cd "$D" || exit 1
  test "$(node "$CLI" --version)" = 14.27.0 || exit 1
  test ! -e "$B/official-functions-output.log" || exit 1
  (set -o noclobber; printf 'One official Functions deployment attempt; not trial activation.\n' > "$B/official-functions-once.attempt") || exit 1
  cd "$B/operation/game" || exit 1
  echo 'OFFICIAL_FUNCTIONS_ONLY: gate and trial dates remain unchanged; normal Firebase output follows.'
  node "$CLI" deploy --project="$P" --config firebase.trial.json --only 'functions:floating-garden-trial:floatingGardenCreateRoom,functions:floating-garden-trial:floatingGardenJoinRoom,functions:floating-garden-trial:floatingGardenStartMatch,functions:floating-garden-trial:floatingGardenGetSnapshot,functions:floating-garden-trial:floatingGardenSubmitAction' --non-interactive 2>&1 | tee "$B/official-functions-output.log"
  E=("${PIPESTATUS[@]}")
  printf 'FIREBASE_EXIT: %s; LOG_EXIT: %s; do not repeat.\n' "${E[0]}" "${E[1]}"
  if test "${E[0]}" != 0; then exit "${E[0]}"; fi
  exit "${E[1]}"
)
