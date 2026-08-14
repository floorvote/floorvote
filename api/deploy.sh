#!/bin/bash
set -e

ENV=${1:?Usage: npm run deploy:tenant -- <wrangler-env-name>  (e.g. my-org)}

cd "$(dirname "$0")"

# The D1 database to migrate, read from the env's own binding in wrangler.toml.
#
# This used to be rebuilt from a prefix (RESOURCE_PREFIX-ENV), which meant the
# script held a second, independent opinion about a name wrangler.toml already
# states. Any deployment whose databases are not named <prefix>-<env> got
#   Couldn't find a D1 DB with the name or binding '<prefix>-<env>'
# with nothing pointing at the cause. Reading the binding cannot drift from the
# config it is deploying.
DB=$(awk -v want="[[env.${ENV}.d1_databases]]" '
  $0 == want { inblock = 1; next }
  inblock && /^\[/ { inblock = 0 }
  inblock && /^[[:space:]]*database_name[[:space:]]*=/ {
    sub(/^[^=]*=[[:space:]]*"/, ""); sub(/".*$/, ""); print; exit
  }
' wrangler.toml)

# Fallback for a config that binds D1 some other way. RESOURCE_PREFIX still
# overrides, so existing setups keep working.
if [[ -z "$DB" ]]; then
  DB="${RESOURCE_PREFIX:-floorvote}-${ENV}"
  echo "Note: no database_name under [[env.${ENV}.d1_databases]]; using ${DB}"
fi

# Preflight: refuse to deploy into the wrong Cloudflare account.
#
# wrangler resolves the target account from whatever credentials the shell
# carries — an OAuth session from `wrangler login`, or an exported
# CLOUDFLARE_API_TOKEN — which is not necessarily the account this config
# describes. The failure modes are a confusing mid-deploy 7403 (migrations
# already attempted) or, worse, a successful deploy of one operator's tenant
# into another's account. Comparing the configured account_id against the
# authenticated one up front turns both into a clear stop.
#
# Skipped when wrangler.toml sets no account_id — that is a valid single-account
# setup, and this check has nothing to compare against.
CONFIGURED_ACCOUNT=$(grep -m1 -E '^account_id[[:space:]]*=' wrangler.toml 2>/dev/null | sed -E 's/.*=[[:space:]]*"?([^"[:space:]]+)"?.*/\1/')
if [ -n "$CONFIGURED_ACCOUNT" ]; then
  echo "Checking Cloudflare account..."
  AUTH_OUTPUT=$(npx wrangler whoami 2>&1) || {
    echo "ERROR: could not determine the authenticated Cloudflare account." >&2
    echo "Run 'npx wrangler login', or export the token for account ${CONFIGURED_ACCOUNT}." >&2
    exit 1
  }
  if ! printf '%s' "$AUTH_OUTPUT" | grep -q "$CONFIGURED_ACCOUNT"; then
    echo "ERROR: wrangler is authenticated against a different Cloudflare account." >&2
    echo "  wrangler.toml expects: ${CONFIGURED_ACCOUNT}" >&2
    echo "  Authenticated as:      $(printf '%s' "$AUTH_OUTPUT" | grep -oE 'associated with the email [^ ]+' | sed 's/associated with the email //')" >&2
    echo "Export the right CLOUDFLARE_API_TOKEN (it may live in your shell profile," >&2
    echo "which a non-interactive shell does not source) or run 'npx wrangler login'." >&2
    exit 1
  fi
fi

echo "Building web assets..."
npm run build --prefix ../web

echo "Applying migrations to ${DB}..."
npx wrangler d1 migrations apply "$DB" --env "$ENV" --remote

SHA=$(git rev-parse --short HEAD)
echo "Deploying worker (env: ${ENV}, build: ${SHA})..."
npx wrangler deploy --env "$ENV" --define "BUILD_SHA:'${SHA}'"

# Back up the config that was just deployed, if the operator asked for it.
#
# api/wrangler.toml is gitignored, so it is an untracked working-tree file with
# no version history behind it — lose the checkout and the deploy config for
# every tenant goes with it. Tying the copy to a successful deploy means it
# refreshes exactly when the file changes and never captures a config that was
# never shipped, which a scheduled backup cannot promise.
#
# Opt-in and silent when unset, so this is a no-op for anyone who has not asked:
#   WRANGLER_BACKUP_DIR=~/backups            # enables it
#   WRANGLER_BACKUP_PREFIX=myorg-            # optional, for several checkouts
#     → ~/backups/myorg-api-wrangler.toml
if [[ -n "${WRANGLER_BACKUP_DIR:-}" ]]; then
  dest="${WRANGLER_BACKUP_DIR}/${WRANGLER_BACKUP_PREFIX:-}api-wrangler.toml"
  if cp wrangler.toml "$dest" 2>/dev/null; then
    echo "Backed up wrangler.toml → ${dest}"
  else
    # Loud: the operator asked for a backup and did not get one.
    echo "WARNING: could not back up wrangler.toml to ${dest}" >&2
  fi
fi

echo "Done: ${ENV}"
