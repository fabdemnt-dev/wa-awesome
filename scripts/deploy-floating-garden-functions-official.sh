#!/usr/bin/env bash
# Owner-operated standard Firebase CLI recovery for the existing Garden packet.
# One Functions-only attempt after read-only checks. No gate/date/Rules/Hosting change.
# Normal Firebase output stays visible and in a private local log; never upload debug logs.
# --after-cloudbilling requires approval for that API only; no billing-account or payment change.
(
  set -o pipefail
  umask 077
  B="$HOME/garden-trial-f0bc4eb0"
  P=wa-awesome-garden-stg
  G=asia-northeast1
  M=official-functions
  if test "$#" = 1 && test "$1" = --after-cloudbilling; then M=official-functions-after-cloudbilling; elif test "$#" != 0; then echo 'STOP: unknown mode.'; exit 1; fi
  D="$(mktemp -d "$HOME/garden-official-read.XXXXXX")" || exit 1
  curl --fail --silent --show-error --proto '=https' --max-time 180 'https://raw.githubusercontent.com/fabdemnt-dev/wa-awesome/94bd220a68be34a9497a81f5be37c8d027b214ec/scripts/start-floating-garden-trial-owner.py' -o "$D/read.py" || exit 1
  printf '%s  %s\n' '156ac6bdd5c86418d372ce415f5a926406d399dde39ecf3094f267eb81659c68' "$D/read.py" | sha256sum --check || exit 1
  S="$(python3 -I "$D/read.py" --diagnose-functions)" || exit 1
  printf '%s\n' "$S"
  if ! printf '%s\n' "$S" | grep -Fxq 'READ_ONLY_DONE' || ! printf '%s\n' "$S" | grep -Fxq 'ADMIN: stopped'; then echo 'STOP: stopped state not verified.'; exit 1; fi
  if ! printf '%s\n' "$S" | grep -Fxq 'JOURNAL: DEPLOY=failed:deploy-functions,STOP=new,create-stopped-admin:issued,create-stopped-admin:verified,deploy-functions:issued' || test -e "$B/operation/OPERATION.lock" || test -L "$B/operation/OPERATION.lock"; then echo 'STOP: expected failed attempt not verified.'; exit 1; fi
  if test "$M" = official-functions-after-cloudbilling; then
    if ! python3 -I -c 'import pathlib,stat,sys; b=pathlib.Path(sys.argv[1]); a=b/"official-functions-once.attempt"; p=b/"official-functions-output.log"; assert all(x.is_file() and not x.is_symlink() and x.stat().st_nlink==1 and x.stat().st_size<8388608 for x in (a,p)); t=p.read_text(); assert "cloudbilling.googleapis.com/v1/projects/wa-awesome-garden-stg/billingInfo" in t and "HTTP Error: 403" in t and "Cloud Billing API has not been used" in t' "$B" 2>/dev/null; then echo 'STOP: prior Cloud Billing failure not verified.'; exit 1; fi
  fi
  if printf '%s\n' "$S" | grep -Fxq 'FUNCTIONS_VERIFY: VERIFIED'; then echo 'BACKEND_ALREADY_VERIFIED: no deployment performed.'; exit 0; fi
  export CLOUDSDK_CORE_DISABLE_PROMPTS=true CLOUDSDK_CORE_LOG_HTTP=false CLOUDSDK_CORE_DISABLE_FILE_LOGGING=true
  F="$(gcloud functions list --project="$P" --billing-project="$P" --v2 --regions="$G" --format=json --verbosity=error)" || exit 1
  R="$(gcloud run services list --project="$P" --billing-project="$P" --region="$G" --platform=managed --format=json --verbosity=error)" || exit 1
  if ! printf '%s' "$F" | python3 -I -c 'import json,sys; assert json.load(sys.stdin)==[]' 2>/dev/null || ! printf '%s' "$R" | python3 -I -c 'import json,sys; assert json.load(sys.stdin)==[]' 2>/dev/null; then echo 'STOP: Tokyo resources present or inventory unverified; no deployment.'; exit 1; fi
  A="$(gcloud services list --enabled --project="$P" --billing-project="$P" --format=json --verbosity=error)" || exit 1
  if ! printf '%s' "$A" | python3 -I -c 'import json,sys; v=json.load(sys.stdin); assert type(v)==list; have={x["config"]["name"] for x in v}; need={x+".googleapis.com" for x in "cloudfunctions cloudbuild artifactregistry run eventarc pubsub storage secretmanager firebaseextensions".split()}; missing=need-have; print("EXISTING_API_MISSING: "+",".join(sorted(missing))) if missing else None; assert not missing' 2>/dev/null; then echo 'STOP: existing deployment APIs not verified.'; exit 1; fi
  I="$(gcloud secrets get-iam-policy FLOATING_GARDEN_INVITE_HMAC_KEY --project="$P" --billing-project="$P" --format=json --verbosity=error)" || exit 1
  if ! printf '%s' "$I" | python3 -I -c 'import json,sys; p=json.load(sys.stdin); b=next(b for b in p["bindings"] if b.get("role")=="roles/secretmanager.secretAccessor"); assert not b.get("condition") and "serviceAccount:garden-trial-runtime@wa-awesome-garden-stg.iam.gserviceaccount.com" in b.get("members",[])' 2>/dev/null; then echo 'STOP: existing runtime secret access not verified.'; exit 1; fi
  CLI="$B/tooling/node_modules/firebase-tools/lib/bin/firebase.js"
  cd "$D" || exit 1
  test "$(node "$CLI" --version)" = 14.27.0 || exit 1
  test ! -e "$B/$M-output.log" || exit 1
  test ! -e "$B/$M-once.attempt" && test ! -L "$B/$M-once.attempt" || exit 1
  if ! printf '%s' "$A" | python3 -I -c 'import json,sys; assert any(x["config"]["name"]=="cloudbilling.googleapis.com" for x in json.load(sys.stdin))' 2>/dev/null; then
    if test "$M" != official-functions-after-cloudbilling; then echo 'STOP: Cloud Billing API requires approval.'; exit 1; fi
    (set -o noclobber; printf 'One approved Cloud Billing API enable attempt; no billing-account change.\n' > "$B/$M-api-enable.attempt") || exit 1
    gcloud services enable cloudbilling.googleapis.com --project="$P" --billing-project="$P" --verbosity=error
    echo 'BILLING_API_READBACK: no enable retry; checking only.'
  fi
  READY=0
  for N in 1 2 3 4 5 6 7 8 9 10 11 12; do
    Z="$(gcloud services list --enabled --project="$P" --billing-project="$P" --format=json --verbosity=error)" || exit 1
    if ! printf '%s\0%s' "$A" "$Z" | python3 -I -c 'import json,sys; a,z=(json.loads(v) for v in sys.stdin.read().split("\0")); a={x["config"]["name"] for x in a}; z={x["config"]["name"] for x in z}; assert a<=z and z-a<={"cloudbilling.googleapis.com"}' 2>/dev/null; then echo 'STOP: unexpected API inventory change.'; exit 1; fi
    if printf '%s' "$Z" | python3 -I -c 'import json,sys; assert any(x["config"]["name"]=="cloudbilling.googleapis.com" for x in json.load(sys.stdin))' 2>/dev/null; then
      if T="$(gcloud billing projects describe "$P" --project="$P" --billing-project="$P" --format='json(projectId,billingEnabled)' --verbosity=error 2>/dev/null)"; then
        if ! printf '%s' "$T" | python3 -I -c 'import json,sys; v=json.load(sys.stdin); assert v.get("projectId")=="wa-awesome-garden-stg" and v.get("billingEnabled") is True' 2>/dev/null; then echo 'STOP: existing billing association is not verified active; no account changes.'; exit 1; fi
        READY=1; break
      fi
    fi
    if test "$N" != 12; then echo 'WAIT: billing readback only.'; sleep 10; fi
  done
  if test "$READY" != 1; then echo 'STOP: billing state not verified; no account change or deployment.'; exit 1; fi
  echo 'BILLING_READY: existing billing association verified; unchanged.'
  (set -o noclobber; printf 'One official Functions deployment attempt; not trial activation.\n' > "$B/$M-once.attempt") || exit 1
  cd "$B/operation/game" || exit 1
  echo 'OFFICIAL_FUNCTIONS_ONLY: gate and trial dates remain unchanged; normal Firebase output follows.'
  node "$CLI" deploy --project="$P" --config firebase.trial.json --only 'functions:floating-garden-trial:floatingGardenCreateRoom,functions:floating-garden-trial:floatingGardenJoinRoom,functions:floating-garden-trial:floatingGardenStartMatch,functions:floating-garden-trial:floatingGardenGetSnapshot,functions:floating-garden-trial:floatingGardenSubmitAction' --non-interactive 2>&1 | tee "$B/$M-output.log"
  E=("${PIPESTATUS[@]}")
  printf 'FIREBASE_EXIT: %s; LOG_EXIT: %s; do not repeat.\n' "${E[0]}" "${E[1]}"
  echo 'POST_DEPLOY_READ_ONLY: checking the stopped gate and deployed Functions.'
  Q="$(python3 -I "$D/read.py" --diagnose-functions)"; V=$?
  printf '%s\n' "$Q"
  if test "$V" != 0 || ! printf '%s\n' "$Q" | grep -Fxq 'READ_ONLY_DONE' || ! printf '%s\n' "$Q" | grep -Fxq 'ADMIN: stopped' || ! printf '%s\n' "$Q" | grep -Fxq 'FUNCTIONS_VERIFY: VERIFIED'; then echo 'STOP: post-deploy verification incomplete; inspect without retry.'; exit 1; fi
  echo 'BACKEND_VERIFIED_STILL_STOPPED: no trial activation or date change.'
  if test "${E[0]}" != 0; then exit "${E[0]}"; fi
  exit "${E[1]}"
)
