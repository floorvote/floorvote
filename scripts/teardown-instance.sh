#!/usr/bin/env bash
# teardown-instance.sh — Decommission a tenant instance and its CF resources
# (LegiScan path).
#
# Usage:
#   ./scripts/teardown-instance.sh <tenant-id> [--r2-bucket <name>] [--dry-run]
#
# Arguments:
#   tenant-id              The env key used in wrangler.toml (e.g. my-org, ri, demo).
#                          Derives: Worker name    → floorvote-{id}
#                                   Queue name     → floorvote-{id}-queue
#                                   D1 name        → floorvote-{id}
#                                   Central binding → TENANT_{ID} (CentralApi; uppercased, hyphens→underscores)
#
# Options:
#   --r2-bucket <name>     Also delete a legacy per-tenant R2 bucket (pre-central
#                          tenants only; modern tenants have none). Empty it via the
#                          CF dashboard first.
#   --dry-run              Print every command without executing it.
#
# Manual steps required (the script does NOT edit wrangler.toml or deploy):
#   BEFORE running:
#     1. Remove [env.{id}] from api/wrangler.toml
#     2. Remove the TENANT_{ID} CentralApi service binding from central/wrangler.toml
#        (the [[env.legiscan.services]] block with entrypoint = "CentralApi")
#   AFTER running:
#     3. Redeploy central so it drops the now-dangling binding:
#        cd central && npm run deploy:legiscan
#
# Chicken-and-egg notes:
#   - Can't delete a Worker while it's a queue consumer → remove the consumer first
#   - Can't delete a queue while the Worker binds it → delete the Worker first
#   - wrangler delete uses the Worker name (not --env), since the env block is already gone
#   - Don't redeploy central until both the Worker is deleted AND the binding is
#     removed from central/wrangler.toml — else the deploy fails on a missing service
#
# Central DB cleanup (LegiScan central = central-bills-ls, --env legiscan):
#   - Marks the tenant inactive in central's `tenants` table (stops the ingestor from
#     notifying a queue that no longer exists)
#   - Deletes the tenant's keywords from `keyword_registry` (removes them from the
#     per-state keyword union so the state's bills aren't pulled unnecessarily)
#   - Does NOT delete bill_tenants rows — harmless dead data, and the LegiScan cache
#     (central R2 + bills table) is untouched, so re-spinup costs zero LegiScan calls
#
# Example — dry run:
#   ./scripts/teardown-instance.sh ri --dry-run

set -euo pipefail

TENANT_ID="${1:-}"
if [ -z "$TENANT_ID" ]; then
  echo "Usage: $0 <tenant-id> [--r2-bucket <name>] [--dry-run]"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WORKER_NAME="floorvote-${TENANT_ID}"
QUEUE_NAME="floorvote-${TENANT_ID}-queue"
D1_NAME="floorvote-${TENANT_ID}"
CENTRAL_DB="central-bills-ls"
CENTRAL_CONFIG="$REPO_ROOT/central/wrangler.toml"
CENTRALAPI_BINDING="TENANT_$(echo "$TENANT_ID" | tr '[:lower:]' '[:upper:]' | tr '-' '_')"

R2_BUCKET=""
DRY_RUN=false

shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --r2-bucket) R2_BUCKET="$2"; shift 2 ;;
    --dry-run)   DRY_RUN=true;   shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

run() {
  if $DRY_RUN; then
    echo "[dry-run] $*"
  else
    echo "+ $*"
    "$@"
  fi
}

echo ""
echo "Tearing down tenant: $TENANT_ID"
echo "  Worker:          $WORKER_NAME"
echo "  Queue:           $QUEUE_NAME"
echo "  D1:              $D1_NAME"
echo "  Central binding: $CENTRALAPI_BINDING (remove from central/wrangler.toml + redeploy after)"
[ -n "$R2_BUCKET" ] && echo "  R2 (legacy):     $R2_BUCKET"
$DRY_RUN && echo "  (dry run — no changes will be made)"
echo ""

# ── Step 1: Remove queue consumer subscription ────────────────────────────────
echo "── Step 1: Remove queue consumer"
run npx wrangler queues consumer remove "$QUEUE_NAME" "$WORKER_NAME"

# ── Step 2: Delete the Worker (releases the custom domain) ─────────────────────
echo ""
echo "── Step 2: Delete Worker"
run npx wrangler delete "$WORKER_NAME"

# ── Step 3: Deactivate tenant in central (LegiScan) DB ────────────────────────
echo ""
echo "── Step 3: Deactivate tenant in central DB"
run npx wrangler d1 execute "$CENTRAL_DB" --remote --env legiscan --config "$CENTRAL_CONFIG" \
  --command "UPDATE tenants SET active = 0 WHERE tenant_id = '${TENANT_ID}'"

# ── Step 4: Remove tenant keywords from central DB ───────────────────────────
echo ""
echo "── Step 4: Remove keywords from central DB"
run npx wrangler d1 execute "$CENTRAL_DB" --remote --env legiscan --config "$CENTRAL_CONFIG" \
  --command "DELETE FROM keyword_registry WHERE tenant_id = '${TENANT_ID}'"

# ── Step 5: Delete D1 database ────────────────────────────────────────────────
echo ""
echo "── Step 5: Delete D1 database"
run npx wrangler d1 delete "$D1_NAME"

# ── Step 6: Delete queue ──────────────────────────────────────────────────────
echo ""
echo "── Step 6: Delete queue"
run npx wrangler queues delete "$QUEUE_NAME"

# ── Step 7 (optional): Delete legacy per-tenant R2 bucket ────────────────────
if [ -n "$R2_BUCKET" ]; then
  echo ""
  echo "── Step 7: Delete legacy R2 bucket ($R2_BUCKET)"
  echo "   Note: bucket must be emptied in the CF dashboard first."
  run npx wrangler r2 bucket delete "$R2_BUCKET"
fi

echo ""
echo "✓ Teardown complete for $TENANT_ID."
echo ""
echo "Remaining manual steps:"
echo "  1. Remove the [env.${TENANT_ID}] block from api/wrangler.toml (if not already)."
echo "  2. Remove the ${CENTRALAPI_BINDING} CentralApi binding from central/wrangler.toml."
echo "  3. Redeploy central to drop the dangling binding:"
echo "       cd central && npm run deploy:legiscan"
echo ""
echo "When re-spinning up '$TENANT_ID' later:"
echo "  - LegiScan cache is intact in central R2 + bills table — seeding hits the cache, not LegiScan."
echo "  - Follow docs/spinning-up-instances.md."
