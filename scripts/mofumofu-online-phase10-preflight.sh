#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
backup_dir="mofumofu-phase10-backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -- "$backup_dir"
cp -- firestore.rules database.rules.json firebase.json "$backup_dir/"
sha256sum firestore.rules database.rules.json firebase.json > "$backup_dir/SHA256SUMS"
git diff -- firestore.rules database.rules.json firebase.json functions/index.js functions/mofumofu-online toybox/mofumofu-gathering > "$backup_dir/pre-deploy.diff"
git status --short
sha256sum -c "$backup_dir/SHA256SUMS"
printf '%s\n' 'Review the backup and diff. Use only the explicit commands in docs/mofumofu-online-phase10-deploy.md.'
