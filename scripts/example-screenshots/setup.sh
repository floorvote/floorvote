#!/usr/bin/env bash
set -euo pipefail

# Sets up a local dev environment for taking product screenshots.
#
# What it does:
#   1. Wipes the local D1 database
#   2. Starts the dev server (API + web)
#   3. Seeds with standard dev data, then applies the example overlay
#
# After it finishes, navigate to http://localhost:5173/bills/bill-early-vote,
# paste scripts/example-screenshots/injections.js into the console, and
# screenshot.  Then run:
#
#   python3 scripts/example-screenshots/frame.py screenshot.png output.png

cd "$(dirname "$0")/../.."

echo "==> Wiping local DB state…"
rm -rf api/.wrangler/state

echo "==> Starting dev server in background…"
npm run dev:local &
DEV_PID=$!
trap "kill $DEV_PID 2>/dev/null || true" EXIT

echo "==> Waiting for API to come up…"
for i in $(seq 1 30); do
  if curl -sf http://localhost:8787/api/health > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "==> Applying example-screenshot seed overlay…"
cd api
npx wrangler d1 execute floorvote-dev --local --env dev --file=../scripts/example-screenshots/seed.sql
cd ..

echo ""
echo "Ready. The dev server is running (PID $DEV_PID)."
echo ""
echo "  1. Open http://localhost:5173/bills/bill-early-vote"
echo "  2. Paste scripts/example-screenshots/injections.js into the console"
echo "  3. Take the screenshot"
echo "  4. python3 scripts/example-screenshots/frame.py <screenshot.png> <output.png>"
echo ""
echo "Press Ctrl-C to stop the server."
wait $DEV_PID
