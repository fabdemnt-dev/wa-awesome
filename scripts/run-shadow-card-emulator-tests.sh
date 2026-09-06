#!/usr/bin/env bash
set -euo pipefail

project_id="${FIREBASE_PROJECT_ID:-demo-shadow-card}"
if [[ "$project_id" != demo-* ]]; then
  echo "STOP: Emulator test project ID must begin with demo-." >&2
  exit 2
fi
if [[ "${GCLOUD_PROJECT:-$project_id}" != "$project_id" ]]; then
  echo "STOP: GCLOUD_PROJECT and FIREBASE_PROJECT_ID do not match." >&2
  exit 2
fi
export GCLOUD_PROJECT="$project_id"
export SHADOW_CARD_TEST_ROUND_SECONDS="${SHADOW_CARD_TEST_ROUND_SECONDS:-1}"
export SHADOW_CARD_INVITE_HMAC_KEY="${SHADOW_CARD_INVITE_HMAC_KEY:-emulator-only-invite-key}"
export SHADOW_CARD_IP_HMAC_KEY="${SHADOW_CARD_IP_HMAC_KEY:-emulator-only-ip-key}"
export FIREBASE_SKIP_UPDATE_CHECK=true

node_major="$(node -p 'process.versions.node.split(".")[0]')"
java_major="$(java -version 2>&1 | awk -F'[".]' '/version/ {print $2; exit}')"
if [[ "$node_major" != 20 ]]; then echo "STOP: Node.js 20 is required (found $(node --version))." >&2; exit 2; fi
if (( java_major < 21 )); then echo "STOP: Java 21 or newer is required." >&2; exit 2; fi
npx firebase --version

echo "[1/3] Pure logic and invite-code tests"
npm run test:shadow-card:local
echo "[2/3] Minimal Callable Function"
npx firebase --config .emulator-minimal/firebase.json emulators:exec --only functions --project demo-minimal "node .emulator-minimal/call.mjs"
echo "[3/3] Four-emulator integration"
npx firebase --config firebase.shadow-card-emulator.json emulators:exec --only auth,firestore,database,functions --project demo-shadow-card "node --test --test-force-exit --test-concurrency=1 tests/shadow-card-integration.test.mjs tests/shadow-card-extra-security.test.mjs"

echo "[cleanup] Waiting for emulator shutdown and port release..."
port_free() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ! ss -tln 2>/dev/null | grep -qE "[:.]${port} "
  elif command -v netstat >/dev/null 2>&1; then
    ! netstat -tln 2>/dev/null | grep -qE "[:.]${port} "
  else
    return 0
  fi
}
deadline=$((SECONDS + 90))
while (( SECONDS < deadline )); do
  if port_free 9099 && port_free 8080 && port_free 9000 && port_free 5001; then
    echo "[cleanup] Emulator ports 9099/8080/9000/5001 released"
    break
  fi
  sleep 1
done
if port_free 9099 && port_free 8080 && port_free 9000 && port_free 5001; then
  echo "[cleanup] All emulators shut down cleanly"
else
  echo "[cleanup] WARNING: some emulator ports are still listening" >&2
  exit 3
fi
