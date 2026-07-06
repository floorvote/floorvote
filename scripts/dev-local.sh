#!/usr/bin/env bash
# dev-local.sh — one-command seeded, auto-logged-in local dev for FloorVote.
#
# Boots the tenant Worker (api/, port 8787) + Vite web (port 5173) against a
# fresh local D1 (`floorvote-dev`) seeded with realistic fake data. DEMO_MODE
# is forced on, so the browser auto-logs in as `demo-user` — no magic link.
#
# Runnable from ANY worktree: pulls api/.dev.vars from the main checkout if the
# current tree doesn't have one (a worktree never gets the gitignored secrets).
#
# Usage:  npm run dev:local      (from repo root, or any worktree root)
set -euo pipefail

# --- locate roots -----------------------------------------------------------
# Repo root of THIS worktree (where api/, web/, scripts/ live).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Main checkout = parent of the shared .git common dir. In a worktree, the
# common dir is <main>/.git, so its parent is the main checkout root. In the
# main checkout itself this resolves to the same place. `--path-format=absolute`
# avoids the relative `.git` that `--git-common-dir` returns in a main checkout
# (which would otherwise resolve against the wrong CWD if run from a subdir).
GIT_COMMON_DIR="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)"
MAIN_CHECKOUT="$(dirname "$GIT_COMMON_DIR")"

echo "==> dev:local"
echo "    worktree root : $ROOT"
echo "    main checkout : $MAIN_CHECKOUT"

# --- 1. ensure api/.dev.vars exists (copy from main checkout if missing) -----
DEV_VARS="$ROOT/api/.dev.vars"
if [ ! -f "$DEV_VARS" ]; then
  SRC="$MAIN_CHECKOUT/api/.dev.vars"
  if [ -f "$SRC" ]; then
    echo "==> api/.dev.vars missing — copying from main checkout"
    cp "$SRC" "$DEV_VARS"
  else
    echo "ERROR: api/.dev.vars not found here or in main checkout ($SRC)." >&2
    echo "       Create api/.dev.vars (see CLAUDE.md 'Required secrets')." >&2
    exit 1
  fi
fi

# Force DEMO_MODE=true so local visitors are auto-logged-in as demo-user.
#
# This edits .dev.vars in place, so back it up first and restore it on exit.
# Without this, running dev:local in the MAIN checkout would permanently flip
# DEMO_MODE=true there, silently auto-logging-in a later plain `npm run dev`.
# (The trap fires on Ctrl-C / normal exit — which is why we don't `exec` the
# dev server below.)
DEV_VARS_BACKUP="$(mktemp)"
cp "$DEV_VARS" "$DEV_VARS_BACKUP"
restore_dev_vars() {
  if [ -f "$DEV_VARS_BACKUP" ]; then
    mv "$DEV_VARS_BACKUP" "$DEV_VARS"
    echo "==> restored original api/.dev.vars"
  fi
}
trap restore_dev_vars EXIT

if grep -q '^DEMO_MODE=' "$DEV_VARS"; then
  # Replace any existing value with true (portable in-place edit).
  tmp="$(mktemp)"
  sed 's/^DEMO_MODE=.*/DEMO_MODE=true/' "$DEV_VARS" > "$tmp" && mv "$tmp" "$DEV_VARS"
else
  printf '\nDEMO_MODE=true\n' >> "$DEV_VARS"
fi
echo "==> DEMO_MODE=true ensured in api/.dev.vars (restored on exit)"

# --- 2. install deps if missing ---------------------------------------------
if [ ! -d "$ROOT/node_modules" ]; then
  echo "==> node_modules missing — running npm install"
  (cd "$ROOT" && npm install)
fi

# --- 3. fresh local D1: migrate + seed --------------------------------------
echo "==> applying tenant migrations to local D1 (floorvote-dev)"
(cd "$ROOT/api" && npm run migrate:local)

echo "==> seeding local D1 from scripts/seed-dev.sql"
(cd "$ROOT/api" && npx wrangler d1 execute floorvote-dev --local --env dev \
  --file ../scripts/seed-dev.sql --yes)

# Ensure the demo auto-login user exists. seed-dev.sql seeds named users but
# DEMO_MODE auto-login resolves the fixed id `demo-user`; without this row,
# /api/* requests 401 even though the HTML page sets a session cookie.
echo "==> ensuring demo-user row for auto-login"
(cd "$ROOT/api" && npx wrangler d1 execute floorvote-dev --local --env dev --yes \
  --command "INSERT OR IGNORE INTO users (id, email, name, role, subtitle, can_vote, created_at) VALUES ('demo-user', 'demo@example.com', 'Demo User', 'owner', 'Demo Account', 1, datetime('now'));")

# --- 4. start the app (api 8787 + web 5173) ---------------------------------
echo ""
echo "==> starting app: api http://localhost:8787  |  web http://localhost:5173"
echo "    Open http://localhost:5173 — you'll be auto-logged-in (DEMO_MODE)."
echo ""
# Point the Vite /api proxy at the LOCAL worker (default config targets the
# hosted demo). The web dev script inherits this env var via npm run dev.
export VITE_API_PROXY="http://localhost:8787"
# Not `exec` — we need the EXIT trap above to restore .dev.vars when the dev
# server is stopped (Ctrl-C).
npm run dev --prefix "$ROOT"
