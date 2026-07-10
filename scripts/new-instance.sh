#!/usr/bin/env bash
# Provision a new tenant instance end-to-end (LegiScan path).
#
# Mirrors docs/spinning-up-instances.md — keep the two in sync. For the
# OpenStates self-hosting path, see docs/self-hosting.md (not this script).
#
# Prerequisites:
#   - wrangler authenticated: CLOUDFLARE_API_TOKEN exported (see ~/.zshrc), or `npx wrangler login`
#   - Node.js + npm; `npm install` run at repo root
#   - The LegiScan central Worker (floorvote-central-legiscan) is already deployed
#   - Shared Cloudflare creds in place (account-level, reused by every tenant):
#       CF_AIG_TOKEN (AI Gateway "Run" token) — have it ready (prompted below)
#     The central ADMIN_SECRET is loaded from central/.dev.vars (or --admin-secret / prompt).
#
# Usage:
#   ./scripts/new-instance.sh \
#     --slug ri \
#     --states RI \
#     --name "Rhode Island Town and City Clerks Association" \
#     --admin-email clerk@example.com \
#     --admin-name "Jane Doe" \
#     [--email-provider cloudflare|resend] \
#     [--seed-dir <path> --session-id <id>] \
#     [--admin-secret <central ADMIN_SECRET>] \
#     [--from-step N]
#
#   Multi-state example (pass comma-separated states; STATE var is left empty and
#   state_coverage is seeded in D1):
#   ./scripts/new-instance.sh \
#     --slug mw --states "NJ,RI,WY,WI" \
#     --name "Midwest Association" \
#     --admin-email clerk@example.com --admin-name "Jane Doe"
#
#   --state is kept as an alias for --states (single-state compat).
#   --from-step lets you resume after a failure without re-running earlier steps.
#   --seed-dir/--session-id trigger optional historical seeding (Step 9); omit to
#     let current-session bills flow in on the next central full-sync pass.
#
# After the script completes, the only manual step is verifying the custom domain
# (printed at the end). Bills begin flowing on the next central full-sync pass
# (5/13/23 ET) unless you seeded historical data.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$REPO_ROOT/api"
CENTRAL_DIR="$REPO_ROOT/central"

# ── Shared, account-level values (identical on every tenant) ──────────────────
# Keep these here, or (recommended) set them in a gitignored scripts/.env.ops so a
# rebranded fork never edits this committed file. Env / .env.ops values win over the
# defaults below.
[[ -f "$SCRIPT_DIR/.env.ops" ]] && { set -a; source "$SCRIPT_DIR/.env.ops"; set +a; }

# Resource-name prefix for this deployment's Workers / D1 / queues. Default "floorvote"
# matches the docs. A rebranded deployment sets RESOURCE_PREFIX (e.g. "acme") ONCE and
# every derived name below follows. It MUST match central's TENANT_QUEUE_PREFIX so
# central resolves this tenant's real queue instead of creating a phantom (no consumer).
RESOURCE_PREFIX="${RESOURCE_PREFIX:-floorvote}"
CENTRAL_WORKER_NAME="${CENTRAL_WORKER_NAME:-${RESOURCE_PREFIX}-central-legiscan}"
ACCOUNT_SUBDOMAIN="${ACCOUNT_SUBDOMAIN:-<your-subdomain>}"
CENTRAL_URL="${CENTRAL_URL:-https://${CENTRAL_WORKER_NAME}.${ACCOUNT_SUBDOMAIN}.workers.dev}"
CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-REPLACE_WITH_ACCOUNT_ID}"
CF_AIG_GATEWAY="${CF_AIG_GATEWAY:-}"           # your Cloudflare AI Gateway slug (required)
# ES256 public JWK — central is the sole issuer; tenants only verify. Not a secret;
# the same value is committed in every [env.*] block in api/wrangler.toml.
SUPERADMIN_JWT_PUBLIC_KEY="${SUPERADMIN_JWT_PUBLIC_KEY:-<your-ES256-public-JWK>}"  # paste the full JSON from your existing tenant block

# ── Logging ───────────────────────────────────────────────────────────────────
log()      { echo "[$(date '+%Y-%m-%d %H:%M:%S')]  $*"; }
log_ok()   { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✓ $*"; }
log_warn() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠ $*"; }
die()      { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✗ FATAL: $*" >&2; exit 1; }

usage() {
  grep '^#' "$0" | grep -v '^#!/' | sed 's/^# \{0,1\}//'
  exit 1
}

# ── Step runner ───────────────────────────────────────────────────────────────
STEP_NUM=0
FROM_STEP=1

step() {
  STEP_NUM=$((STEP_NUM + 1))
  if [[ $STEP_NUM -lt $FROM_STEP ]]; then
    log "↷ Skipping step $STEP_NUM: $*"
    return 1
  fi
  echo
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ━━━ Step $STEP_NUM: $* ━━━"
  return 0
}

# ── Load central ADMIN_SECRET from central/.dev.vars ───────────────────────────
CENTRAL_DEV_VARS="$CENTRAL_DIR/.dev.vars"
if [[ -f "$CENTRAL_DEV_VARS" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$CENTRAL_DEV_VARS"; set +a
fi

# ── Parse args ────────────────────────────────────────────────────────────────
SLUG=""
STATES_CSV=""
ASSOC_NAME=""
ADMIN_EMAIL=""
ADMIN_NAME=""
ADMIN_SECRET="${ADMIN_SECRET:-}"   # central ADMIN_SECRET (operator → central)
APP_URL=""
EMAIL_PROVIDER="cloudflare"
SEED_DIR=""
SESSION_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug)           SLUG="$2";           shift 2 ;;
    --states)         STATES_CSV="$2";     shift 2 ;;
    --state)          STATES_CSV="$2";     shift 2 ;;   # alias
    --name)           ASSOC_NAME="$2";     shift 2 ;;
    --admin-email)    ADMIN_EMAIL="$2";    shift 2 ;;
    --admin-name)     ADMIN_NAME="$2";     shift 2 ;;
    --email-provider) EMAIL_PROVIDER="$2"; shift 2 ;;
    --seed-dir)       SEED_DIR="$2";       shift 2 ;;
    --session-id)     SESSION_ID="$2";     shift 2 ;;
    --admin-secret)   ADMIN_SECRET="$2";   shift 2 ;;
    --app-url)        APP_URL="$2";        shift 2 ;;
    --from-step)      FROM_STEP="$2";      shift 2 ;;
    --help|-h)        usage ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ -n "$SLUG" ]]        || die "--slug is required (e.g. ri)"
[[ -n "$STATES_CSV" ]]  || die "--states is required (e.g. RI or NJ,RI,WY,WI)"
[[ -n "$ASSOC_NAME" ]]  || die "--name is required"
[[ -n "$ADMIN_EMAIL" ]] || die "--admin-email is required"
[[ -n "$ADMIN_NAME" ]]  || die "--admin-name is required"
[[ "$EMAIL_PROVIDER" == "cloudflare" || "$EMAIL_PROVIDER" == "resend" ]] \
  || die "--email-provider must be 'cloudflare' or 'resend'"

# Parse STATES_CSV; derive STATE (first element, empty for multi-state)
IFS=',' read -ra STATES_ARR <<< "$STATES_CSV"
IS_MULTI_STATE=false
[[ ${#STATES_ARR[@]} -gt 1 ]] && IS_MULTI_STATE=true
STATE="${STATES_ARR[0]}"
$IS_MULTI_STATE && STATE=""

if [[ -z "$ADMIN_SECRET" ]]; then
  read -rsp "[$(date '+%Y-%m-%d %H:%M:%S')]  Central ADMIN_SECRET: " ADMIN_SECRET
  echo
fi
[[ -n "$ADMIN_SECRET" ]] || die "Central ADMIN_SECRET is required (operator → central auth)"

# Collect per-instance secrets upfront — before the log redirect makes stdout a
# pipe (wrangler refuses to prompt when stdout is not a TTY). Only CF_AIG_TOKEN is
# required; GEMINI/RESEND are optional rollback credentials (blank = skip).
if [[ $FROM_STEP -le 5 ]]; then
  echo
  read -rsp "CF_AIG_TOKEN (required — AI Gateway 'Run' token): " CF_AIG_TOKEN; echo
  [[ -n "$CF_AIG_TOKEN" ]] || die "CF_AIG_TOKEN is required"
  echo "  The next two are OPTIONAL rollback credentials. Leave blank to skip."
  echo "  GEMINI_API_KEY is only read if AI_GATEWAY_ENABLED is flipped to false."
  read -rsp "GEMINI_API_KEY (optional): " GEMINI_API_KEY; echo
  echo "  RESEND_API_KEY is only used if EMAIL_PROVIDER=resend (or the EMAIL binding is absent)."
  read -rsp "RESEND_API_KEY (optional): " RESEND_API_KEY; echo
fi

APP_URL="${APP_URL:-https://${SLUG}.example.com}"
WORKER_NAME="${RESOURCE_PREFIX}-${SLUG}"
WORKER_URL="https://${WORKER_NAME}.${ACCOUNT_SUBDOMAIN}.workers.dev"
DB_NAME="${RESOURCE_PREFIX}-${SLUG}"
QUEUE_NAME="${RESOURCE_PREFIX}-${SLUG}-queue"
SLUG_UPPER="$(echo "$SLUG" | tr '[:lower:]' '[:upper:]' | tr '-' '_')"
CENTRALAPI_BINDING="TENANT_${SLUG_UPPER}"
# Each tenant needs a unique ratelimits namespace_id. Find the max existing id
# (excluding dev=2099) and increment.
RATELIMIT_NS_ID=$(grep 'namespace_id' "$API_DIR/wrangler.toml" \
  | grep -o '"[0-9]*"' | tr -d '"' | grep -v '^2099$' | sort -n | tail -1)
RATELIMIT_NS_ID=$(( ${RATELIMIT_NS_ID:-2000} + 1 ))

# ── Setup log file ─────────────────────────────────────────────────────────────
LOG_DIR="$REPO_ROOT/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/new-instance-${SLUG}-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

log "Log file: $LOG_FILE"
[[ $FROM_STEP -gt 1 ]] && log "Resuming from step $FROM_STEP"

trap 'die "Command failed at line $LINENO — see $LOG_FILE"' ERR

# ── Confirm ───────────────────────────────────────────────────────────────────
echo
echo "  Slug:        $SLUG"
echo "  States:      $STATES_CSV$($IS_MULTI_STATE && echo ' (multi-state)' || true)"
echo "  Association: $ASSOC_NAME"
echo "  App URL:     $APP_URL"
echo "  Worker URL:  $WORKER_URL"
echo "  Email:       $EMAIL_PROVIDER"
echo "  Admin:       $ADMIN_NAME <$ADMIN_EMAIL>"
[[ -n "$SEED_DIR" ]] && echo "  Seed:        $SEED_DIR (session $SESSION_ID)"
echo "  Log:         $LOG_FILE"
[[ $FROM_STEP -gt 1 ]] && echo "  Resuming:    from step $FROM_STEP"
echo
echo "  This deploys the tenant worker AND redeploys central (to bind CentralApi)."
read -rp "Proceed? [y/N] " _confirm
[[ "$_confirm" =~ ^[Yy]$ ]] || { log "Aborted."; exit 0; }

# ── Step 1: Create D1 database ────────────────────────────────────────────────
if step "Create D1 database"; then
  cd "$API_DIR"
  D1_OUTPUT=$(npx wrangler d1 create "$DB_NAME" 2>&1)
  echo "$D1_OUTPUT"
  DB_ID=$(echo "$D1_OUTPUT" | grep -o 'database_id = "[^"]*"' | grep -o '"[^"]*"$' | tr -d '"')
  [[ -n "$DB_ID" ]] || die "Could not extract database_id from wrangler output"
  log_ok "Database created: $DB_ID"
fi

# ── Step 2: Create Queue ───────────────────────────────────────────────────────
if step "Create Queue"; then
  cd "$API_DIR"
  npx wrangler queues create "$QUEUE_NAME"
  log_ok "Queue created: $QUEUE_NAME"
fi

# ── Step 3: Append tenant env block to api/wrangler.toml + commit ──────────────
if step "Add env block to api/wrangler.toml"; then
  [[ -n "${DB_ID:-}" ]] || die "DB_ID unset (resume from step 1, or pass it through)"
  cat >> "$API_DIR/wrangler.toml" <<TOML

[env.${SLUG}]
name = "${WORKER_NAME}"
routes = [{ pattern = "${APP_URL#https://}", custom_domain = true }]

[env.${SLUG}.vars]
APP_URL = "${APP_URL}"
ASSOCIATION_NAME = "${ASSOC_NAME}"
INSTANCE_PRESET = "election_officials"
STATE = "${STATE}"
TENANT_ID = "${SLUG}"
PROVIDER = "legiscan"
CENTRAL_API_URL = "${CENTRAL_URL}"
AI_GATEWAY_ENABLED = "true"
CF_ACCOUNT_ID = "${CF_ACCOUNT_ID}"
CF_AIG_GATEWAY = "${CF_AIG_GATEWAY}"
EMAIL_PROVIDER = "${EMAIL_PROVIDER}"
APP_DOMAINS = "${APP_DOMAINS:-example.com}"
EMAIL_FROM = "${EMAIL_FROM:-notifications@example.com}"
ALERT_EMAILS = "${ALERT_EMAILS:-}"
OPERATOR_NAME = "${OPERATOR_NAME:-}"
OPERATOR_URL = "${OPERATOR_URL:-}"
OPERATOR_CONTACT_EMAILS = "${OPERATOR_CONTACT_EMAILS:-}"
SUPERADMIN_JWT_PUBLIC_KEY='${SUPERADMIN_JWT_PUBLIC_KEY}'
TURNSTILE_SITE_KEY = "\${TURNSTILE_SITE_KEY:-}"

[[env.${SLUG}.d1_databases]]
binding = "DB"
database_name = "${DB_NAME}"
database_id = "${DB_ID}"
migrations_dir = "migrations"

[[env.${SLUG}.queues.producers]]
binding = "BILL_QUEUE"
queue = "${QUEUE_NAME}"

[[env.${SLUG}.queues.consumers]]
queue = "${QUEUE_NAME}"
max_batch_size = 10
max_batch_timeout = 30
max_concurrency = 3
dead_letter_queue = "${RESOURCE_PREFIX}-dlq"

[[env.${SLUG}.ratelimits]]
name = "LOGIN_RATE_LIMITER"
namespace_id = "${RATELIMIT_NS_ID}"
  [env.${SLUG}.ratelimits.simple]
  limit = 10
  period = 60

[[env.${SLUG}.services]]
binding = "CENTRAL"
service = "${CENTRAL_WORKER_NAME}"
entrypoint = "TenantApi"

[[env.${SLUG}.send_email]]
name = "EMAIL"

[env.${SLUG}.triggers]
crons = ["0 11 * * *"]
TOML
  log_ok "Appended [env.${SLUG}] to api/wrangler.toml"

  cd "$REPO_ROOT"
  git add api/wrangler.toml
  git commit -m "chore: add ${SLUG} (${STATES_CSV}) tenant env block" || log_warn "nothing to commit"
  log_ok "Committed api/wrangler.toml"
fi

# ── Step 4: Deploy the tenant worker (builds web + migrations + deploy) ────────
# deploy.sh builds web/, applies pending D1 migrations, then deploys. This also
# creates the Worker (so Step 5 secrets can attach) and provisions the custom domain.
if step "Deploy tenant worker"; then
  cd "$API_DIR"
  npm run deploy:tenant -- "$SLUG"
  log_ok "Worker deployed: $WORKER_URL"
fi

# ── Step 5: Set secrets (worker now exists) ────────────────────────────────────
# Only CF_AIG_TOKEN is required. No CENTRAL_ADMIN_SECRET, no SUPERADMIN_JWT_SECRET —
# both directions are binding-authenticated (TenantApi outbound, CentralApi inbound).
if step "Set secrets"; then
  cd "$API_DIR"
  echo "$CF_AIG_TOKEN" | npx wrangler secret put CF_AIG_TOKEN --env "$SLUG"
  log_ok "CF_AIG_TOKEN set"
  if [[ -n "${GEMINI_API_KEY:-}" ]]; then
    echo "$GEMINI_API_KEY" | npx wrangler secret put GEMINI_API_KEY --env "$SLUG"
    log_ok "GEMINI_API_KEY set (rollback credential)"
  else
    log "GEMINI_API_KEY skipped (gateway path doesn't read it)"
  fi
  if [[ -n "${RESEND_API_KEY:-}" ]]; then
    echo "$RESEND_API_KEY" | npx wrangler secret put RESEND_API_KEY --env "$SLUG"
    log_ok "RESEND_API_KEY set (rollback credential)"
  else
    log "RESEND_API_KEY skipped (EMAIL_PROVIDER=${EMAIL_PROVIDER})"
  fi
fi

# ── Step 5b: Seed state_coverage for multi-state instances ────────────────────
if step "Seed state_coverage in D1 (multi-state)"; then
  if $IS_MULTI_STATE; then
    STATES_JSON=$(export _CSV="$STATES_CSV"; python3 -c "import json,os; print(json.dumps(os.environ['_CSV'].split(',')))")
    cd "$API_DIR"
    npx wrangler d1 execute "$DB_NAME" --remote --env "$SLUG" \
      --command "INSERT OR REPLACE INTO association_config (key, value) VALUES ('state_coverage', '${STATES_JSON}')"
    log_ok "Seeded state_coverage: $STATES_CSV"
  else
    log "Single-state — skipping (STATE env var is sufficient)"
  fi
fi

# ── Step 6: Bind the tenant on central via CentralApi + redeploy central ───────
# central->tenant + operator->tenant calls run over this RPC binding (no shared
# secret). The tenant worker must already exist (Step 4) for central to bind to it.
if step "Bind CentralApi on central + deploy central"; then
  if grep -q "binding = \"${CENTRALAPI_BINDING}\"" "$CENTRAL_DIR/wrangler.toml"; then
    log "CentralApi binding ${CENTRALAPI_BINDING} already present — skipping append"
  else
    cat >> "$CENTRAL_DIR/wrangler.toml" <<TOML

[[env.legiscan.services]]
binding = "${CENTRALAPI_BINDING}"
service = "${WORKER_NAME}"
entrypoint = "CentralApi"
TOML
    log_ok "Appended ${CENTRALAPI_BINDING} CentralApi binding to central/wrangler.toml"
    cd "$REPO_ROOT"
    git add central/wrangler.toml
    git commit -m "chore: bind ${SLUG} CentralApi on central" || log_warn "nothing to commit"
  fi
  cd "$CENTRAL_DIR"
  npm run deploy:legiscan
  log_ok "Central deployed with ${CENTRALAPI_BINDING} binding"
fi

# ── Step 7: Register with central (applies preset, syncs keywords) ─────────────
# force-register routes operator → central → RPC → tenant.forceRegister(), which
# applies INSTANCE_PRESET to the tenant DB and registers state_coverage + keywords.
if step "Register tenant with central"; then
  log "Waiting 10s for the central deploy to settle..."
  sleep 10
  REGISTER_RESP=$(curl -s -X POST "${CENTRAL_URL}/api/tenants/${SLUG}/force-register" \
    -H "x-admin-secret: ${ADMIN_SECRET}" --max-time 60 2>&1) || true
  echo "$REGISTER_RESP"
  if echo "$REGISTER_RESP" | grep -q '"ok":true'; then
    log_ok "Registered with central (preset applied, keywords synced)"
  else
    die "force-register failed: $REGISTER_RESP (check the CentralApi binding deployed in Step 6)"
  fi
fi

# ── Step 8: Seed the active session(s) so the tenant mirrors the whole session ──
# Whole-session monitoring is the default: keyword/manual → full AI, everything
# else → monitor stub. Two paths:
#   • central already has the session (state covered already, or cron discovered it)
#     → seed-session per active session (central→tenant; quota-free; no central rewrite)
#   • brand-new state central has never seen → use --seed-dir to bulk-load central
#     from the LegiScan zip first, THEN seed-session.
# Without either, the tenant still fills on the next full pass (deliver-on-creation).
if step "Seed active session(s) for whole-session monitoring"; then
  if [[ -n "$SEED_DIR" && -n "$SESSION_ID" ]]; then
    [[ -d "$SEED_DIR" ]] || die "--seed-dir not found: $SEED_DIR"
    $IS_MULTI_STATE && die "Multi-state seeding: run scripts/seed-legiscan.ts per state/session manually"
    cd "$REPO_ROOT"
    ADMIN_SECRET="$ADMIN_SECRET" npx tsx scripts/seed-legiscan.ts \
      --from-dir "$SEED_DIR" --state "${STATES_ARR[0]}" \
      --session-id "$SESSION_ID" --tenant "$SLUG" --remote
    log_ok "Seeded central from zip + linked session $SESSION_ID"
  else
    # No zip: seed-session for the current session(s) central already holds for our
    # state(s). Include sessions still active (sine_die=0) OR whose year_end is the current
    # year or later. A just-adjourned session is still exactly what a new tenant wants to
    # monitor — the old sine_die=0-only filter silently seeded NOTHING when a legislature
    # had adjourned its regular session mid-cycle (e.g. a state whose only current sessions
    # are already sine_die).
    for st in "${STATES_ARR[@]}"; do
      SIDS=$(npx wrangler d1 execute central-bills-ls --env legiscan --remote --json \
        --command "SELECT s.session_id AS id FROM sessions s WHERE s.state='${st}' AND s.sync_enabled=1 AND (s.sine_die=0 OR s.year_end >= CAST(strftime('%Y','now') AS INTEGER)) AND EXISTS (SELECT 1 FROM bills b WHERE b.session_id=s.session_id)" \
        2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(' '.join(str(r['id']) for r in d[0]['results']))" 2>/dev/null || echo "")
      if [[ -z "$SIDS" ]]; then
        log_warn "central has no bills yet for ${st} — tenant will fill on the next full pass (or pass --seed-dir to bulk-load)"
        continue
      fi
      seed_ok=1
      for sid in $SIDS; do
        log "seed-session ${SLUG} session ${sid} (${st})..."
        offset=0
        iter=0
        while :; do
          if (( iter++ >= 200 )); then die "seed-session pagination exceeded 200 pages for ${SLUG} session ${sid} — aborting (possible central bug)"; fi
          RESP=$(curl -s -X POST "${CENTRAL_URL}/api/tenants/seed-session/${SLUG}?sessionId=${sid}&offset=${offset}" \
            -H "x-admin-secret: ${ADMIN_SECRET}" --max-time 120)
          if [[ -z "$RESP" ]]; then
            log_warn "seed-session call failed (empty response) for ${SLUG} session ${sid} — re-run Step 8 with --from-step later"
            seed_ok=0
            break
          fi
          echo "$RESP"
          echo "$RESP" | grep -q '"done":true' && break
          NEXT=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('nextOffset') or '')" 2>/dev/null || echo "")
          [[ -z "$NEXT" ]] && break
          offset="$NEXT"
        done
      done
      if [[ "$seed_ok" == "1" ]]; then log_ok "Seeded active session(s) for ${st}"; else log_warn "Seeding incomplete for ${st} — see warnings above"; fi
    done
  fi
fi

# ── Step 9: Create the founding owner user ─────────────────────────────────────
# The first user MUST be 'owner', not 'admin': only an owner can grant the owner
# role (see api/src/routes/adminApi.ts), so a tenant with no owner can never get one.
if step "Create founding owner user"; then
  ADMIN_ID=$(uuidgen 2>/dev/null || python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null) \
    || die "Could not generate a UUID (install uuidgen or python3)"
  cd "$API_DIR"
  SAFE_NAME="${ADMIN_NAME//\'/\'\'}"
  npx wrangler d1 execute "$DB_NAME" --remote --env "$SLUG" \
    --command "INSERT OR IGNORE INTO users (id, email, name, role) VALUES ('${ADMIN_ID}', '${ADMIN_EMAIL}', '${SAFE_NAME}', 'owner')"
  log_ok "Founding owner created: $ADMIN_EMAIL"
fi

# ── Done ───────────────────────────────────────────────────────────────────────
echo
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "Instance '${SLUG}' provisioned."
log ""
log "  Worker:  ${WORKER_URL}"
log "  Target:  ${APP_URL}"
log "  Admin:   ${ADMIN_EMAIL}"
log "  Log:     ${LOG_FILE}"
log ""
log "Verify:  curl ${WORKER_URL}/api/health   → {\"ok\":true}"
log ""
log "Remaining manual step:"
log "  • Custom domain: deploy provisioned it from the routes= block. If using a"
log "    client-owned domain, add the CNAME → ${WORKER_NAME}.${ACCOUNT_SUBDOMAIN}.workers.dev"
log "    and update APP_URL in api/wrangler.toml to match."
log "  • Log in at ${APP_URL} (magic link) and confirm Settings → Configuration."
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
