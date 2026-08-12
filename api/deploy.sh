#!/bin/bash
set -e

ENV=${1:?Usage: npm run deploy:tenant -- <wrangler-env-name>  (e.g. my-org)}
# Resource-name prefix — override RESOURCE_PREFIX if you renamed your Workers/DBs/queues.
# Defaults to "floorvote", matching the names the self-hosting guide has you
# create. Must match the database_name in your wrangler.toml.
DB="${RESOURCE_PREFIX:-floorvote}-${ENV}"

cd "$(dirname "$0")"

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

echo "Done: ${ENV}"
