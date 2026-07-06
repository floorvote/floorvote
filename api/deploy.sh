#!/bin/bash
set -e

ENV=${1:?Usage: npm run deploy:tenant -- <wrangler-env-name>  (e.g. my-org)}
DB="floorvote-${ENV}"

cd "$(dirname "$0")"

echo "Building web assets..."
npm run build --prefix ../web

echo "Applying migrations to ${DB}..."
npx wrangler d1 migrations apply "$DB" --env "$ENV" --remote

echo "Deploying worker (env: ${ENV})..."
npx wrangler deploy --env "$ENV"

echo "Done: ${ENV}"
