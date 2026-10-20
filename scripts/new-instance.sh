#!/usr/bin/env bash
# Provision a new tenant instance end-to-end (LegiScan path).
#
# Mirrors docs/content/self-hosting/tenants.md — keep the two in sync.
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
#     [--no-attachments] \
#     [--from-step N] \
#     [--preflight-only]
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
#   --preflight-only runs the validation below and exits without provisioning
#     anything. Every run preflights first regardless; this just stops after it.
#   --no-attachments skips the private R2 bucket for comment attachments (step 3)
#     and its binding, leaving attachments off. They are on by default.
#   --seed-dir/--session-id trigger optional historical seeding (step 10); omit to
#     let current-session bills flow in on the next central full-sync pass.
#
# The last step runs scripts/verify-instance.sh, a smoke test of the new instance:
# health and build, registration on central, queue delivery, one AI analysis (one
# AI call), and a sample email to ALERT_EMAILS. If a check fails it names the
# likely cause and prints the --from-step command to resume from, and the script
# exits non-zero. Run it any time on an existing instance:
#   ./scripts/verify-instance.sh <slug> [--ai] [--to <email>]
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
ENV_OPS_FILE="$SCRIPT_DIR/.env.ops"
ENV_OPS_LOADED=0
[[ -f "$ENV_OPS_FILE" ]] && { set -a; source "$ENV_OPS_FILE"; set +a; ENV_OPS_LOADED=1; }

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

# step <key> <description>. The key records this step's number in STEP_NO_<key>
# (even when it is skipped), so the verification step can tell the operator which
# --from-step to resume from without hard-coding numbers that shift when a step is
# added.
step() {
  local key="$1"; shift
  STEP_NUM=$((STEP_NUM + 1))
  printf -v "STEP_NO_${key}" '%s' "$STEP_NUM"
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
ORIG_ARGS=("$@")
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
PREFLIGHT_ONLY=0
ATTACHMENTS=1

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
    --preflight-only) PREFLIGHT_ONLY=1;     shift 1 ;;
    --no-attachments) ATTACHMENTS=0;        shift 1 ;;
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

# A bare `read` here fails under `set -e` when stdin is not a terminal, and the
# ERR trap does not exist yet, so the script would exit silently with no output
# at all. Tolerate the failed read and let the explicit check below report it.
if [[ -z "$ADMIN_SECRET" ]]; then
  if [[ -t 0 ]]; then
    read -rsp "[$(date '+%Y-%m-%d %H:%M:%S')]  Central ADMIN_SECRET: " ADMIN_SECRET || true
    echo
  else
    log_warn "no terminal to prompt for ADMIN_SECRET — pass --admin-secret, or set it in central/.dev.vars"
  fi
fi
# Preflight reports a missing secret among the other findings rather than dying
# here, so one run surfaces every problem instead of one per re-run.
if [[ $PREFLIGHT_ONLY -eq 0 ]]; then
  [[ -n "$ADMIN_SECRET" ]] || die "Central ADMIN_SECRET is required (operator → central auth)"
fi

# Collect per-instance secrets upfront — before the log redirect makes stdout a
# pipe (wrangler refuses to prompt when stdout is not a TTY). Only CF_AIG_TOKEN is
# required; GEMINI and RESEND are optional (blank = skip).
if [[ $FROM_STEP -le 6 && $PREFLIGHT_ONLY -eq 0 ]]; then
  echo
  read -rsp "CF_AIG_TOKEN (required — AI Gateway 'Run' token): " CF_AIG_TOKEN || \
    die "could not read CF_AIG_TOKEN — this prompt needs a terminal. Run interactively, or use --preflight-only to validate without it."
  echo
  [[ -n "$CF_AIG_TOKEN" ]] || die "CF_AIG_TOKEN is required"
  echo "  The next two are OPTIONAL. Leave blank to skip."
  echo "  GEMINI_API_KEY is only read if AI_GATEWAY_ENABLED is flipped to false."
  read -rsp "GEMINI_API_KEY (optional): " GEMINI_API_KEY; echo
  echo "  RESEND_API_KEY is a second email sender. Resend goes first unless EMAIL_PROVIDER=cloudflare with"
  echo "  an EMAIL binding; with that, it is the fallback for sign-in, account, notification, and operator"
  echo "  email when the binding fails. Digests and week-ahead mail never fall back."
  read -rsp "RESEND_API_KEY (optional): " RESEND_API_KEY; echo
fi

# Default the tenant URL from APP_DOMAINS (set in scripts/.env.ops) rather than a
# placeholder: a deployment that has already declared its domain should not need
# --app-url on every run. Falling back to example.com silently produced a tenant
# whose route pointed at a zone Cloudflare could not find, failing the deploy
# AFTER the env block had been committed. --app-url still wins.
if [[ -z "$APP_URL" && -n "${APP_DOMAINS:-}" ]]; then
  APP_URL="https://${SLUG}.${APP_DOMAINS%%,*}"
fi
APP_URL="${APP_URL:-https://${SLUG}.example.com}"
WORKER_NAME="${RESOURCE_PREFIX}-${SLUG}"
WORKER_URL="https://${WORKER_NAME}.${ACCOUNT_SUBDOMAIN}.workers.dev"
DB_NAME="${RESOURCE_PREFIX}-${SLUG}"
QUEUE_NAME="${RESOURCE_PREFIX}-${SLUG}-queue"
BUCKET_NAME="${RESOURCE_PREFIX}-${SLUG}-files"
SLUG_UPPER="$(echo "$SLUG" | tr '[:lower:]' '[:upper:]' | tr '-' '_')"
CENTRALAPI_BINDING="TENANT_${SLUG_UPPER}"
# Each tenant needs two unique ratelimits namespace_ids, one for the login limiter
# and one for the mute-link limiter. Find the max existing id (excluding the dev
# env's 2099 and 2098) and take the next two.
# `|| true` matters: under `set -o pipefail` a grep that matches nothing makes
# this assignment fail, and `set -e` then exits the script silently, before the
# ERR trap is installed -- no message, no log file, exit 1. That happens on any
# fresh clone, where api/wrangler.toml has no namespace_id lines yet (or does
# not exist at all).
RATELIMIT_NS_ID=$(grep 'namespace_id' "$API_DIR/wrangler.toml" 2>/dev/null \
  | grep -o '"[0-9]*"' | tr -d '"' | grep -v -e '^2099$' -e '^2098$' | sort -n | tail -1 || true)
RATELIMIT_NS_ID=$(( ${RATELIMIT_NS_ID:-2000} + 1 ))
MUTE_RATELIMIT_NS_ID=$(( RATELIMIT_NS_ID + 1 ))

# ── Setup log file ─────────────────────────────────────────────────────────────
LOG_DIR="$REPO_ROOT/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/new-instance-${SLUG}-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

log "Log file: $LOG_FILE"
[[ $FROM_STEP -gt 1 ]] && log "Resuming from step $FROM_STEP"

trap 'die "Command failed at line $LINENO — see $LOG_FILE"' ERR

# ── Preflight ─────────────────────────────────────────────────────────────────
# Validate everything BEFORE mutating anything. The script's failure mode has
# always been that it appends config, commits it, and deploys before discovering
# a problem -- so a bad run leaves committed state behind and surfaces as an
# unrelated-looking Cloudflare API error several steps later.
#
# The specific incident this was written for: with scripts/.env.ops absent, the
# operator defaults below silently fall back to the upstream "floorvote" prefix.
# The run appended `service = "floorvote-<slug>"` to central/wrangler.toml,
# COMMITTED it, and then failed on central's deploy with
# `code: 10143 -- Worker 'floorvote-<slug>' not found`, which reads like a
# Cloudflare problem rather than a missing local file. .env.ops is gitignored, so
# this fires in every fresh clone and every new git worktree, not just on a first
# install.
#
# Anything that would produce a broken tenant is fatal here. Anything merely
# unusual warns. The only thing preflight mutates is the shared dead-letter
# queue, which is created if absent (see below) because every tenant's consumer
# references it and the deploy fails outright without it.
PF_FAIL=0
# macOS ships no `timeout`, so bound slow calls by hand: run in the background,
# poll, and kill on expiry. Without this a hung DNS lookup stalls the whole run
# with no output, which is how this was first hit.
pf_timeout() {
  local secs="$1"; shift
  "$@" & local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if (( waited >= secs )); then kill -9 "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; return 124; fi
    sleep 1; waited=$((waited + 1))
  done
  wait "$pid"
}
pf_ok()   { echo "    ✓ $*"; }
pf_warn() { echo "    ⚠ $*"; }
pf_bad()  { echo "    ✗ $*"; PF_FAIL=1; }

preflight() {
  echo
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ━━━ Preflight ━━━"

  # 1. Operator config -- the silent-fallback trap.
  echo "  Operator config:"
  if [[ $ENV_OPS_LOADED -eq 1 ]]; then
    pf_ok "loaded $ENV_OPS_FILE"
  else
    pf_warn "no $ENV_OPS_FILE (fine only if these values come from the environment)"
  fi
  local placeholder=0
  [[ "$CF_ACCOUNT_ID" == "REPLACE_WITH_ACCOUNT_ID" ]] && { pf_bad "CF_ACCOUNT_ID is still the placeholder"; placeholder=1; }
  [[ "$ACCOUNT_SUBDOMAIN" == "<your-subdomain>" ]]    && { pf_bad "ACCOUNT_SUBDOMAIN is still the placeholder"; placeholder=1; }
  [[ "$SUPERADMIN_JWT_PUBLIC_KEY" == "<your-ES256-public-JWK>" ]] && { pf_bad "SUPERADMIN_JWT_PUBLIC_KEY is still the placeholder"; placeholder=1; }
  [[ -z "${CF_AIG_GATEWAY:-}" ]] && pf_bad "CF_AIG_GATEWAY is empty (required -- AI silently does nothing without it)"
  [[ "$CENTRAL_URL" == *"<your-subdomain>"* ]] && pf_bad "CENTRAL_URL still contains a placeholder: $CENTRAL_URL"
  if [[ $placeholder -eq 1 && $ENV_OPS_LOADED -eq 0 ]]; then
    pf_bad "these are the built-in defaults: this run would provision with the wrong names."
    echo "      Create $ENV_OPS_FILE (it is gitignored, so each clone/worktree needs its own)"
    echo "      or export the values. Copy from another checkout that has one."
  fi
  [[ $placeholder -eq 0 ]] && pf_ok "prefix=$RESOURCE_PREFIX central=$CENTRAL_WORKER_NAME account=${CF_ACCOUNT_ID:0:8}…"

  # Stop here if the config itself is wrong. Everything below talks to
  # Cloudflare or to central, which is pointless with placeholder values -- and
  # check 6 CREATES a queue, which must never happen on a run already known to
  # be misconfigured (it would be created under the wrong resource prefix).
  if [[ $PF_FAIL -eq 1 ]]; then
    echo
    die "Preflight failed on operator config. Nothing has been provisioned and no remote calls were made."
  fi

  # 2. wrangler identity. A token for the wrong account fails later as an
  #    opaque `code: 7403 -- the given account is not valid or is not
  #    authorized`, which reads like a permissions problem, not a wrong login.
  echo "  Cloudflare auth:"
  local whoami
  if whoami=$(pf_timeout 60 npx wrangler whoami 2>&1); then
    if grep -q "$CF_ACCOUNT_ID" <<<"$whoami"; then
      pf_ok "authenticated, and CF_ACCOUNT_ID is among the accessible accounts"
    else
      pf_bad "authenticated, but CF_ACCOUNT_ID ($CF_ACCOUNT_ID) is NOT among the accessible accounts"
      echo "      Export the right CLOUDFLARE_API_TOKEN, or \`npx wrangler login\` as the right identity."
    fi
  else
    pf_bad "npx wrangler whoami failed -- not authenticated"
  fi

  # 3. Queue prefix agreement. Central derives a tenant's queue name from its own
  #    TENANT_QUEUE_PREFIX; if that disagrees with RESOURCE_PREFIX, central
  #    resolves a queue that does not exist, creates a phantom with no consumer,
  #    and the tenant receives no bills -- with nothing anywhere reporting an error.
  echo "  Queue naming:"
  if [[ -f "$CENTRAL_DIR/wrangler.toml" ]]; then
    local cprefix
    # BSD sed (macOS) has no \s, so use POSIX classes; cut on quotes instead of
    # a substitution so the pattern stays readable.
    cprefix=$(grep -E '^[[:space:]]*TENANT_QUEUE_PREFIX[[:space:]]*=' "$CENTRAL_DIR/wrangler.toml" | head -1 | cut -d'"' -f2 || true)
    if [[ -z "$cprefix" ]]; then
      pf_warn "central/wrangler.toml sets no TENANT_QUEUE_PREFIX (central defaults apply)"
    elif [[ "$cprefix" == "$RESOURCE_PREFIX" ]]; then
      pf_ok "central TENANT_QUEUE_PREFIX matches RESOURCE_PREFIX ($cprefix)"
    else
      pf_bad "central TENANT_QUEUE_PREFIX ('$cprefix') != RESOURCE_PREFIX ('$RESOURCE_PREFIX')"
      echo "      Central would look for '${cprefix}-${SLUG}-queue' while this creates"
      echo "      '${RESOURCE_PREFIX}-${SLUG}-queue'. The tenant would silently receive no bills."
    fi
  else
    pf_warn "no central/wrangler.toml here -- cannot cross-check the queue prefix"
  fi

  # 4. Config file present. Absent on a fresh upstream clone, where it must be
  #    created from api/wrangler.example.toml before any tenant can be added.
  echo "  Tenant config file:"
  if [[ -f "$API_DIR/wrangler.toml" ]]; then
    pf_ok "api/wrangler.toml exists"
  else
    pf_bad "api/wrangler.toml does not exist — create it from api/wrangler.example.toml first"
    echo "      It needs the top-level [assets] block (with run_worker_first = [\"/api/*\"])"
    echo "      and account_id before any tenant env block is appended."
  fi

  # 5. Name collisions. Appending a second [env.<slug>] block yields a config
  #    whose later keys quietly win.
  echo "  Name collisions:"
  if grep -qE "^\[env\.${SLUG}\]" "$API_DIR/wrangler.toml" 2>/dev/null; then
    if [[ $FROM_STEP -gt 4 ]]; then
      pf_ok "[env.$SLUG] already present (resuming past step 4 -- expected)"
    else
      pf_bad "[env.$SLUG] already exists in api/wrangler.toml -- pick another slug, or --from-step 5"
    fi
  else
    pf_ok "slug '$SLUG' is free in api/wrangler.toml"
  fi
  if grep -q "namespace_id = \"${RATELIMIT_NS_ID}\"" "$API_DIR/wrangler.toml" 2>/dev/null; then
    pf_bad "ratelimit namespace_id $RATELIMIT_NS_ID is already used -- tenants would share a login budget"
  else
    pf_ok "ratelimit namespace_id $RATELIMIT_NS_ID is free"
  fi
  if grep -q "namespace_id = \"${MUTE_RATELIMIT_NS_ID}\"" "$API_DIR/wrangler.toml" 2>/dev/null; then
    pf_bad "ratelimit namespace_id $MUTE_RATELIMIT_NS_ID is already used -- tenants would share a mute-link budget"
  else
    pf_ok "ratelimit namespace_id $MUTE_RATELIMIT_NS_ID is free"
  fi
  # The attachments bucket. R2 refuses a name outside 3-63 lowercase letters,
  # digits, and hyphens, which a slug can produce, and that would otherwise fail
  # only at step 3. A name another instance already binds is allowed (each
  # instance keeps its files under its TENANT_ID) but is unlikely to be meant.
  if [[ $ATTACHMENTS -eq 1 ]]; then
    if [[ ! "$BUCKET_NAME" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]]; then
      pf_bad "bucket name $BUCKET_NAME is not a valid R2 name (3-63 lowercase letters, digits, hyphens) -- pick another slug, or --no-attachments"
    elif grep -q "bucket_name = \"${BUCKET_NAME}\"" "$API_DIR/wrangler.toml" 2>/dev/null; then
      if [[ $FROM_STEP -gt 4 ]]; then
        pf_ok "bucket $BUCKET_NAME already bound (resuming past step 4 -- expected)"
      else
        pf_warn "bucket $BUCKET_NAME is already bound in api/wrangler.toml: this instance would share it"
      fi
    else
      pf_ok "bucket $BUCKET_NAME is free in api/wrangler.toml"
    fi
  fi

  # 6. Central reachable, and the admin secret actually works. force-register
  #    (step 9) is otherwise the first thing to find out, long after the deploys.
  echo "  Central:"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "$CENTRAL_URL/api/health" --max-time 20 || echo 000)
  if [[ "$code" == "200" ]]; then
    pf_ok "reachable at $CENTRAL_URL"
  else
    pf_bad "GET $CENTRAL_URL/api/health returned $code (expected 200)"
  fi
  if [[ -z "${ADMIN_SECRET:-}" ]]; then
    pf_bad "ADMIN_SECRET is empty -- set it in central/.dev.vars, --admin-secret, or the environment"
  else
    # /api/admin/* sits behind the x-admin-secret middleware and `superadmin/check`
    # is its only side-effect-free GET, so it answers exactly the question asked:
    # 200 = secret accepted, 401 = rejected. /api/tenants cannot: it registers no
    # bare GET, so every run fell through to the SPA catch-all -- and central binds
    # no ASSETS, making that a hard 404 and failing preflight for every operator.
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "x-admin-secret: $ADMIN_SECRET" "$CENTRAL_URL/api/admin/superadmin/check" --max-time 20 || echo 000)
    if [[ "$code" == "200" ]]; then pf_ok "ADMIN_SECRET accepted by central"
    else pf_bad "central rejected ADMIN_SECRET (HTTP $code on /api/admin/superadmin/check)"; fi
  fi

  # 7. The shared dead-letter queue. Every tenant's consumer names it and the
  #    tenant deploy fails outright if it is absent, but nothing creates it --
  #    so create-or-confirm it here. This is preflight's one mutation, and it is
  #    idempotent and shared rather than tenant-specific.
  echo "  Shared dead-letter queue:"
  local dlq="${RESOURCE_PREFIX}-dlq"
  if pf_timeout 60 npx wrangler queues list 2>/dev/null | grep -qE "(^|[[:space:]])${dlq}([[:space:]]|$)"; then
    pf_ok "$dlq exists"
  elif [[ $PF_FAIL -eq 1 ]]; then
    pf_warn "$dlq missing -- NOT creating it, because a check above already failed"
  else
    pf_warn "$dlq missing -- creating it (every tenant consumer references it)"
    if pf_timeout 60 npx wrangler queues create "$dlq" >/dev/null 2>&1; then pf_ok "created $dlq"
    else pf_bad "could not create $dlq -- the tenant deploy will fail referencing it"; fi
  fi

  # 8. Seed inputs, before an hour of work is spent reaching them.
  if [[ -n "$SEED_DIR" || -n "$SESSION_ID" ]]; then
    echo "  Seed data:"
    [[ -n "$SEED_DIR" && -n "$SESSION_ID" ]] || pf_bad "--seed-dir and --session-id must be given together"
    if [[ -n "$SEED_DIR" ]]; then
      if [[ -d "$SEED_DIR" ]]; then
        local missing=""
        for sub in bill vote people; do [[ -d "$SEED_DIR/$sub" ]] || missing="$missing $sub"; done
        if [[ -z "$missing" ]]; then pf_ok "$SEED_DIR has bill/ vote/ people/"
        else pf_bad "$SEED_DIR is missing:$missing"; fi
      else
        pf_bad "--seed-dir does not exist: $SEED_DIR"
      fi
    fi
    $IS_MULTI_STATE && pf_bad "--seed-dir cannot be combined with a multi-state tenant (seed each session separately)"
  fi

  # 9. Whether api/wrangler.toml is committable. Upstream gitignores it; forks
  #    that track it expect the commit. Step 4 must not assume either way.
  echo "  Config tracking:"
  if git -C "$REPO_ROOT" check-ignore -q api/wrangler.toml 2>/dev/null; then
    WRANGLER_TOML_TRACKED=0
    pf_ok "api/wrangler.toml is gitignored here -- the env block will not be committed"
  else
    WRANGLER_TOML_TRACKED=1
    pf_ok "api/wrangler.toml is tracked -- the env block will be committed after a successful deploy"
  fi

  echo
  if [[ $PF_FAIL -eq 1 ]]; then
    die "Preflight failed. Nothing has been provisioned. Fix the ✗ items above and re-run."
  fi
  log_ok "Preflight passed -- nothing provisioned yet"
}

WRANGLER_TOML_TRACKED=1
preflight
if [[ $PREFLIGHT_ONLY -eq 1 ]]; then
  log "--preflight-only: stopping here."
  exit 0
fi

# ── Confirm ───────────────────────────────────────────────────────────────────
echo
echo "  Slug:        $SLUG"
echo "  States:      $STATES_CSV$($IS_MULTI_STATE && echo ' (multi-state)' || true)"
echo "  Association: $ASSOC_NAME"
echo "  App URL:     $APP_URL"
echo "  Worker URL:  $WORKER_URL"
echo "  Email:       $EMAIL_PROVIDER"
echo "  Attachments: $([[ $ATTACHMENTS -eq 1 ]] && echo "on (bucket $BUCKET_NAME)" || echo off)"
echo "  Admin:       $ADMIN_NAME <$ADMIN_EMAIL>"
[[ -n "$SEED_DIR" ]] && echo "  Seed:        $SEED_DIR (session $SESSION_ID)"
echo "  Log:         $LOG_FILE"
[[ $FROM_STEP -gt 1 ]] && echo "  Resuming:    from step $FROM_STEP"
echo
echo "  This deploys the tenant worker AND redeploys central (to bind CentralApi)."
read -rp "Proceed? [y/N] " _confirm
[[ "$_confirm" =~ ^[Yy]$ ]] || { log "Aborted."; exit 0; }

# ── Step 1: Create D1 database ────────────────────────────────────────────────
if step db "Create D1 database"; then
  cd "$API_DIR"
  D1_OUTPUT=$(npx wrangler d1 create "$DB_NAME" 2>&1)
  echo "$D1_OUTPUT"
  DB_ID=$(echo "$D1_OUTPUT" | grep -o 'database_id = "[^"]*"' | grep -o '"[^"]*"$' | tr -d '"')
  [[ -n "$DB_ID" ]] || die "Could not extract database_id from wrangler output"
  log_ok "Database created: $DB_ID"
fi

# ── Step 2: Create Queue ───────────────────────────────────────────────────────
if step queue "Create Queue"; then
  cd "$API_DIR"
  npx wrangler queues create "$QUEUE_NAME"
  log_ok "Queue created: $QUEUE_NAME"
fi

# ── Step 3: Create the R2 bucket for comment attachments ──────────────────────
# A new bucket is private: no public access and no r2.dev URL. Uploads and
# downloads go through the Worker's binding, so it needs no CORS rule or token.
# A bucket left by an earlier, failed run is reused.
if step files "Create R2 bucket for comment attachments"; then
  if [[ $ATTACHMENTS -eq 0 ]]; then
    log "--no-attachments: no bucket, so comment attachments stay off"
  else
    cd "$API_DIR"
    if R2_OUTPUT=$(npx wrangler r2 bucket create "$BUCKET_NAME" 2>&1); then
      echo "$R2_OUTPUT"
      log_ok "Bucket created: $BUCKET_NAME"
    elif grep -qiE "already exists|code: 10004" <<<"$R2_OUTPUT"; then
      log_ok "Bucket $BUCKET_NAME already exists -- reusing it"
    else
      echo "$R2_OUTPUT"
      die "Could not create bucket $BUCKET_NAME (or re-run with --no-attachments)"
    fi
  fi
fi

# ── Step 4: Append tenant env block to api/wrangler.toml ──────────────────────
# Deliberately does NOT commit. The commit moved to the end of step 5, after the
# deploy succeeds: committing first meant a failed deploy left the bad config in
# history, which is exactly how a wrong-prefix run got recorded before anything
# reported an error. An uncommitted working-tree change is trivial to inspect or
# discard; a commit is not.
if step envblock "Add env block to api/wrangler.toml"; then
  [[ -n "${DB_ID:-}" ]] || die "DB_ID unset (resume from step 1, or pass it through)"
  # Idempotent so a failed step 5 can be retried with --from-step 4 without
  # appending a duplicate block (whose later keys would quietly win).
  if grep -qE "^\\[env\\.${SLUG}\\]" "$API_DIR/wrangler.toml"; then
    log "[env.${SLUG}] already present — leaving it as is"
  else
  R2_TOML=""
  if [[ $ATTACHMENTS -eq 1 ]]; then
    printf -v R2_TOML '# Comment attachments: the private bucket from step 3.\n[[env.%s.r2_buckets]]\nbinding = "ATTACHMENTS_BUCKET"\nbucket_name = "%s"\n\n' "$SLUG" "$BUCKET_NAME"
  fi
  cat >> "$API_DIR/wrangler.toml" <<TOML

[env.${SLUG}]
name = "${WORKER_NAME}"
routes = [{ pattern = "${APP_URL#https://}", custom_domain = true }]

# wrangler doesn't inherit the top-level [define] into named environments, so
# each env needs its own or wrangler warns on every command. BUILD_SHA is
# overridden at deploy; "'dev'" is just the placeholder.
[env.${SLUG}.define]
BUILD_SHA = "'dev'"

[env.${SLUG}.vars]
APP_URL = "${APP_URL}"
ASSOCIATION_NAME = "${ASSOC_NAME}"
STATE = "${STATE}"
TENANT_ID = "${SLUG}"
CENTRAL_API_URL = "${CENTRAL_URL}"
AI_GATEWAY_ENABLED = "true"
CF_ACCOUNT_ID = "${CF_ACCOUNT_ID}"
CF_AIG_GATEWAY = "${CF_AIG_GATEWAY}"
EMAIL_PROVIDER = "${EMAIL_PROVIDER}"
APP_DOMAINS = "${APP_DOMAINS:-example.com}"
EMAIL_FROM = "${EMAIL_FROM:-notifications@example.com}"
EMAIL_FROM_BULK = "${EMAIL_FROM_BULK:-}"
ALERT_EMAILS = "${ALERT_EMAILS:-}"
OPERATOR_NAME = "${OPERATOR_NAME:-}"
# Terms-acceptance gate: unset means off. Set it to the date of the last
# material change to docs/legal/ only when hosting under your own documents,
# and never on a demo tenant. See api/wrangler.example.toml.
# LEGAL_TERMS_UPDATED = ""
OPERATOR_URL = "${OPERATOR_URL:-}"
OPERATOR_CONTACT_EMAILS = "${OPERATOR_CONTACT_EMAILS:-}"
SUPERADMIN_JWT_PUBLIC_KEY='${SUPERADMIN_JWT_PUBLIC_KEY}'
TURNSTILE_SITE_KEY = "${TURNSTILE_SITE_KEY:-}"

[[env.${SLUG}.d1_databases]]
binding = "DB"
database_name = "${DB_NAME}"
database_id = "${DB_ID}"
migrations_dir = "migrations"

${R2_TOML}[[env.${SLUG}.queues.producers]]
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

# One-click mute link: 120 requests per 60s per IP (mail providers send many
# members' unsubscribes from a few IPs).
[[env.${SLUG}.ratelimits]]
name = "MUTE_LINK_RATE_LIMITER"
namespace_id = "${MUTE_RATELIMIT_NS_ID}"
  [env.${SLUG}.ratelimits.simple]
  limit = 120
  period = 60

[[env.${SLUG}.services]]
binding = "CENTRAL"
service = "${CENTRAL_WORKER_NAME}"
entrypoint = "TenantApi"
# Object-level authz. Central reads this as ctx.props.tenantId -- a per-binding
# value Cloudflare sets at deploy time and guarantees unforgeable -- and rejects
# tenant-scoped calls targeting a different tenant. Omit it and central finds no
# caller id and falls back to lenient mode for this tenant. MUST equal TENANT_ID.
props = { tenantId = "${SLUG}" }

[[env.${SLUG}.send_email]]
name = "EMAIL"

# Both crons are required: src/index.ts dispatches on the cron string, so a
# missing schedule disables its job silently. Daily sends the digest and
# week-ahead emails; hourly re-queues bills whose AI analysis the provider
# gateway shed and never retried.
[env.${SLUG}.triggers]
crons = ["0 11 * * *", "0 * * * *"]
TOML
  log_ok "Appended [env.${SLUG}] to api/wrangler.toml (uncommitted until the deploy succeeds)"
  fi
fi

# ── Step 5: Deploy the tenant worker (builds web + migrations + deploy) ────────
# deploy.sh builds web/, applies pending D1 migrations, then deploys. This also
# creates the Worker (so step 6 secrets can attach) and provisions the custom domain.
if step deploy "Deploy tenant worker"; then
  cd "$API_DIR"
  # deploy.sh stamps the build with this commit. The commits below move HEAD, so
  # record it now for the verification step to expect.
  BUILD_SHA_DEPLOYED="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  npm run deploy:tenant -- "$SLUG"
  log_ok "Worker deployed: $WORKER_URL"

  # Now that the config is known-good, record it. Upstream gitignores
  # api/wrangler.toml; forks that track it expect the commit. Preflight decided
  # which case this is, so `git add` neither fails nor needs -f.
  if [[ "${WRANGLER_TOML_TRACKED:-1}" -eq 1 ]]; then
    cd "$REPO_ROOT"
    git add api/wrangler.toml
    git commit -m "chore: add ${SLUG} (${STATES_CSV}) tenant env block" || log_warn "nothing to commit"
    log_ok "Committed api/wrangler.toml"
  else
    log "api/wrangler.toml is gitignored here — not committing (this is the upstream default)"
  fi
fi

# ── Step 6: Set secrets (worker now exists) ────────────────────────────────────
# Only CF_AIG_TOKEN is required. No CENTRAL_ADMIN_SECRET, and no superadmin signing
# key: central is the sole issuer and holds SUPERADMIN_JWT_PRIVATE_KEY, while a tenant
# only ever verifies, using the public JWK in its vars. Both directions are
# binding-authenticated (TenantApi outbound, CentralApi inbound).
if step secrets "Set secrets"; then
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
    log_ok "RESEND_API_KEY set (second email sender)"
  else
    log "RESEND_API_KEY skipped (EMAIL_PROVIDER=${EMAIL_PROVIDER})"
  fi
fi

# ── Step 7: Seed state_coverage for multi-state instances ─────────────────────
if step coverage "Seed state_coverage in D1 (multi-state)"; then
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

# ── Step 8: Bind the tenant on central via CentralApi + redeploy central ───────
# central->tenant + operator->tenant calls run over this RPC binding (no shared
# secret). The tenant worker must already exist (step 5) for central to bind to it.
if step bind "Bind CentralApi on central + deploy central"; then
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
  fi
  cd "$CENTRAL_DIR"
  npm run deploy:legiscan
  log_ok "Central deployed with ${CENTRALAPI_BINDING} binding"
  # Committed only now: a binding naming a worker that does not exist fails this
  # deploy with `code: 10143`, and that bad binding should not already be in
  # history when it does.
  if ! git -C "$REPO_ROOT" check-ignore -q central/wrangler.toml 2>/dev/null; then
    cd "$REPO_ROOT"
    git add central/wrangler.toml
    git commit -m "chore: bind ${SLUG} CentralApi on central" || log_warn "nothing to commit"
  else
    log "central/wrangler.toml is gitignored here — not committing"
  fi
fi

# ── Step 9: Register with central (syncs keywords + state coverage) ────────────
# force-register routes operator → central → RPC → tenant.forceRegister(), which
# calls ensureAssociationName (seeds association_name from ASSOCIATION_NAME, only
# over the migration placeholder) and registers the tenant's keywords — empty on
# a new instance — and state coverage with central.
if step register "Register tenant with central"; then
  log "Waiting 10s for the central deploy to settle..."
  sleep 10
  REGISTER_RESP=$(curl -s -X POST "${CENTRAL_URL}/api/tenants/${SLUG}/force-register" \
    -H "x-admin-secret: ${ADMIN_SECRET}" --max-time 60 2>&1) || true
  echo "$REGISTER_RESP"
  if echo "$REGISTER_RESP" | grep -q '"ok":true'; then
    log_ok "Registered with central (keywords + state coverage synced)"
  else
    die "force-register failed: $REGISTER_RESP (check the CentralApi binding deployed in step 8)"
  fi
fi

# ── Step 10: Seed the active session(s) so the tenant mirrors the whole session ─
# Whole-session monitoring is the default: keyword/manual → full AI, everything
# else → monitor stub. Two paths:
#   • central already has the session (state covered already, or cron discovered it)
#     → seed-session per active session (central→tenant; quota-free; no central rewrite)
#   • brand-new state central has never seen → use --seed-dir to bulk-load central
#     from the LegiScan zip first, THEN seed-session.
# Without either, the tenant still fills on the next full pass (deliver-on-creation).
if step seed "Seed active session(s) for whole-session monitoring"; then
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
    #
    # That widening still assumed the state sits every year. Biennial legislatures
    # (NV, MT, ND, TX, ...) meet in odd years only, so in an even year EVERY session is
    # sine_die with a year_end in the past and the filter matches nothing — the tenant is
    # provisioned empty and, because deliver-on-creation only carries NEW bills and the
    # state has none until the next biennium, it never fills. That is the same silent
    # failure the comment above describes, one cycle out. So: if the current-session
    # filter finds nothing, fall back to the most recent year that actually has bills.
    # A tenant monitoring last session's bills is the right answer for an off-year
    # state, and is strictly better than an empty instance.
    d1_session_ids() {
      npx wrangler d1 execute central-bills-ls --env legiscan --remote --json \
        --command "$1" \
        2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(' '.join(str(r['id']) for r in d[0]['results']))" 2>/dev/null || echo ""
    }
    for st in "${STATES_ARR[@]}"; do
      SIDS=$(d1_session_ids "SELECT s.session_id AS id FROM sessions s WHERE s.state='${st}' AND s.sync_enabled=1 AND (s.sine_die=0 OR s.year_end >= CAST(strftime('%Y','now') AS INTEGER)) AND EXISTS (SELECT 1 FROM bills b WHERE b.session_id=s.session_id)")
      if [[ -z "$SIDS" ]]; then
        # Off-year fallback: every session of the most recent year that has bills.
        # Matching on year_end (not a single max session_id) keeps a regular session
        # and its special sessions together, which is what the current-session branch
        # above also returns.
        SIDS=$(d1_session_ids "SELECT s.session_id AS id FROM sessions s WHERE s.state='${st}' AND s.sync_enabled=1 AND EXISTS (SELECT 1 FROM bills b WHERE b.session_id=s.session_id) AND s.year_end = (SELECT MAX(s2.year_end) FROM sessions s2 WHERE s2.state=s.state AND s2.sync_enabled=1 AND EXISTS (SELECT 1 FROM bills b2 WHERE b2.session_id=s2.session_id))")
        [[ -n "$SIDS" ]] && log_warn "${st} has no session in progress — seeding the most recent session(s) with bills instead (biennial or off-year legislature)"
      fi
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
            log_warn "seed-session call failed (empty response) for ${SLUG} session ${sid} — re-run step 10 with --from-step later"
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

# ── Step 11: Create the founding owner user ────────────────────────────────────
# The first user MUST be 'owner', not 'admin': only an owner can grant the owner
# role (see api/src/routes/adminApi.ts), so a tenant with no owner can never get one.
if step owner "Create founding owner user"; then
  ADMIN_ID=$(uuidgen 2>/dev/null || python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null) \
    || die "Could not generate a UUID (install uuidgen or python3)"
  cd "$API_DIR"
  SAFE_NAME="${ADMIN_NAME//\'/\'\'}"
  npx wrangler d1 execute "$DB_NAME" --remote --env "$SLUG" \
    --command "INSERT OR IGNORE INTO users (id, email, name, role) VALUES ('${ADMIN_ID}', '${ADMIN_EMAIL}', '${SAFE_NAME}', 'owner')"
  log_ok "Founding owner created: $ADMIN_EMAIL"
fi

# ── Step 12: Verify the instance end to end ────────────────────────────────────
# Several of the steps above can fail without saying so: the site loads, but bills
# never arrive or email never sends. verify-instance.sh proves health, registration,
# queue delivery, AI, and email, and on a failure names the check, its likely cause,
# and the --from-step to resume from. It runs the AI check here (one AI call); run it
# by hand without --ai to skip that.
#
# Everything is passed explicitly rather than re-read, so the check sees exactly the
# values this run provisioned with. --expect-build is the commit step 5 deployed, or
# "any" when resuming past it (this run cannot know what an earlier one deployed).
resume_cmd() {
  # The command that resumes this run. --from-step is dropped so the verifier's
  # replaces it, and the admin secret is never echoed: it is read from
  # central/.dev.vars, the environment, or a prompt on the next run.
  local out="./scripts/new-instance.sh" skip=0 a
  for a in "${ORIG_ARGS[@]}"; do
    if [[ $skip -eq 1 ]]; then skip=0; continue; fi
    case "$a" in
      --from-step|--admin-secret) skip=1; continue ;;
    esac
    out+=" $(printf '%q' "$a")"
  done
  echo "$out"
}

VERIFY_FAILED=0
if step verify "Verify the instance end to end"; then
  if ! ADMIN_SECRET="$ADMIN_SECRET" bash "$SCRIPT_DIR/verify-instance.sh" "$SLUG" --ai \
      --central-url "$CENTRAL_URL" --worker-url "$WORKER_URL" --app-url "$APP_URL" \
      --prefix "$RESOURCE_PREFIX" --states "$STATES_CSV" \
      --expect-build "${BUILD_SHA_DEPLOYED:-any}" \
      --resume-cmd "$(resume_cmd)" \
      --resume-steps "deploy=${STEP_NO_deploy},secrets=${STEP_NO_secrets},bind=${STEP_NO_bind},register=${STEP_NO_register},verify=${STEP_NO_verify}"; then
    # The summary below still prints, since its manual steps apply either way;
    # the run then exits non-zero.
    VERIFY_FAILED=1
    log_warn "Instance '${SLUG}' is provisioned, but it did not pass verification. See the failures above."
  else
    log_ok "Instance verified end to end"
  fi
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
if [[ $VERIFY_FAILED -eq 1 ]]; then
  log "NOT verified: fix the failures printed by step ${STEP_NO_verify}, resume with the"
  log "command it printed, or re-run the check by hand:"
else
  log "Verified end to end by scripts/verify-instance.sh. Re-run it any time:"
fi
log "  ./scripts/verify-instance.sh ${SLUG}"
log ""
log "Remaining manual step:"
log "  • Custom domain: deploy provisioned it from the routes= block. If using a"
log "    client-owned domain, add the CNAME → ${WORKER_NAME}.${ACCOUNT_SUBDOMAIN}.workers.dev"
log "    and update APP_URL in api/wrangler.toml to match."
log "  • Log in at ${APP_URL} (magic link) and confirm Settings → Configuration."
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
[[ $VERIFY_FAILED -eq 0 ]] || exit 1
