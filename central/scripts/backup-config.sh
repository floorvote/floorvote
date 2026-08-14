#!/bin/bash
# Back up the central wrangler.toml that was just deployed, if the operator asked
# for it. Mirrors the same step in api/deploy.sh — see the comment there for why
# this is tied to a deploy rather than a schedule.
#
# central/wrangler.toml is gitignored, so it is an untracked working-tree file
# with no version history behind it: account id, the D1 and R2 names, the queue
# bindings, and the tenant service bindings all live only in that one file.
#
# Opt-in and silent when unset:
#   WRANGLER_BACKUP_DIR=~/backups       # enables it
#   WRANGLER_BACKUP_PREFIX=myorg-       # optional, for several checkouts
#     → ~/backups/myorg-central-wrangler.toml
#
# Runs as npm's postdeploy:legiscan hook, so it fires only after the whole deploy
# chain (build, migrate, deploy, smoke) has succeeded.
set -uo pipefail
cd "$(dirname "$0")/.."

[[ -n "${WRANGLER_BACKUP_DIR:-}" ]] || exit 0

dest="${WRANGLER_BACKUP_DIR}/${WRANGLER_BACKUP_PREFIX:-}central-wrangler.toml"
if cp wrangler.toml "$dest" 2>/dev/null; then
  echo "Backed up central/wrangler.toml → ${dest}"
else
  # Loud: the operator asked for a backup and did not get one. Not fatal — the
  # worker is already live, and failing here would misreport a good deploy.
  echo "WARNING: could not back up central/wrangler.toml to ${dest}" >&2
fi
