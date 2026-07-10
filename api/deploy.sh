#!/bin/bash
set -e

ENV=${1:?Usage: npm run deploy:tenant -- <wrangler-env-name>  (e.g. my-org)}
# Resource-name prefix — override RESOURCE_PREFIX if you renamed your Workers/DBs/queues
# (default "floorvote", matching the docs). Must match the database_name in wrangler.toml.
DB="${RESOURCE_PREFIX:-floorvote}-${ENV}"

cd "$(dirname "$0")"

echo "Building web assets..."
npm run build --prefix ../web

echo "Applying migrations to ${DB}..."
npx wrangler d1 migrations apply "$DB" --env "$ENV" --remote

SHA=$(git rev-parse --short HEAD)
echo "Deploying worker (env: ${ENV}, build: ${SHA})..."
npx wrangler deploy --env "$ENV" --define "BUILD_SHA:'${SHA}'"

echo "Done: ${ENV}"
