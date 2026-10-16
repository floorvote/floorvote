#!/usr/bin/env bash
# Smoke-test a provisioned instance end to end.
#
# new-instance.sh runs this as its last step; run it by hand against any existing
# instance too, for example after a deploy.
#
# Usage:
#   ./scripts/verify-instance.sh <slug> [--ai] [--to <email>] [options]
#   ./scripts/verify-instance.sh --help        (full option list)
#
# Five checks, each cheap and none visible to the organization's members:
#   1. Health and build    the instance answers /api/health with the expected build
#   2. Registration        central knows the instance, its states, and keywords
#   3. Queue delivery      central sends one already-stored bill and it arrives
#   4. AI analysis         one stored bill is analyzed end to end (opt-in with --ai,
#                          since it costs one AI call; reports "skipped" if the
#                          instance has no AI configured)
#   5. Email               a sample email goes to the operator (the instance's
#                          ALERT_EMAILS, or --to), never a sign-in link
#
# None calls LegiScan, emails the instance's admin or members, or changes which
# bills the instance tracks. Exits non-zero if any check fails, naming the check
# and its likely cause.
#
# Configuration comes from the same places new-instance.sh reads, so a deployment
# with its own RESOURCE_PREFIX, domain, and central needs no flags:
#   scripts/.env.ops      RESOURCE_PREFIX, ACCOUNT_SUBDOMAIN, CENTRAL_URL, APP_DOMAINS, ...
#   central/.dev.vars     ADMIN_SECRET (or --admin-secret, or a prompt)
#   api/wrangler.toml     the instance's own APP_URL and ALERT_EMAILS
# The instance's workers.dev URL is used when its custom domain isn't verified yet.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# A secret handed in by the caller (new-instance.sh, or the shell) outranks the file.
CALLER_ADMIN_SECRET="${ADMIN_SECRET:-}"
[[ -f "$SCRIPT_DIR/.env.ops" ]] && { set -a; source "$SCRIPT_DIR/.env.ops"; set +a; }
[[ -f "$REPO_ROOT/central/.dev.vars" ]] && { set -a; source "$REPO_ROOT/central/.dev.vars"; set +a; }
[[ -n "$CALLER_ADMIN_SECRET" ]] && export ADMIN_SECRET="$CALLER_ADMIN_SECRET"

# Prompt for the secret only when nothing supplied it and there is a terminal;
# new-instance.sh exports it, and a flag also works.
wants_help=0
has_secret_flag=0
for arg in "$@"; do
  [[ "$arg" == "--help" || "$arg" == "-h" ]] && wants_help=1
  [[ "$arg" == "--admin-secret" ]] && has_secret_flag=1
done
if [[ $wants_help -eq 0 && $has_secret_flag -eq 0 && -z "${ADMIN_SECRET:-}" && -t 0 ]]; then
  read -rsp "Central ADMIN_SECRET: " ADMIN_SECRET || true
  echo
  export ADMIN_SECRET
fi

cd "$REPO_ROOT"
exec npx tsx scripts/verify-instance.ts "$@"
