#!/usr/bin/env bash
# PreToolUse hook: when a worktree/branch is about to be created, remind which
# base to branch from — upstream/main for upstream-bound features, fork main
# for fork-only (operator overlay) work. Wired (in .claude/settings.json) to
# the EnterWorktree tool and to Bash `git worktree add` / `git checkout -b`.
# Inject-and-proceed: it never blocks the tool, it just adds a note.
input=$(cat)
hit=$(printf '%s' "$input" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
t = d.get("tool_input", d)
cmd = str(t.get("command", "") or "")
creating_worktree = bool(t.get("name")) and not t.get("path")  # EnterWorktree create (not enter-existing)
if creating_worktree or ("git worktree add" in cmd) or ("checkout -b" in cmd):
    sys.stdout.write("1")
' 2>/dev/null || true)
if [ "$hit" = "1" ]; then
  python3 -c '
import json
msg = ("Creating a branch/worktree — decide the base first. If this feature might be contributed "
       "UPSTREAM (floorvote/floorvote), branch from upstream/main, NOT fork main — see the "
       "\"Forking and operator overlays\" section in CONTRIBUTING.md. EnterWorktree defaults to "
       "fork main, so an upstream-bound feature needs `git worktree add <path> upstream/main` "
       "instead. For fork-only work (deploy/tenant/operator-overlay changes), fork main is correct.")
print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": msg}}))
' 2>/dev/null || true
fi
exit 0
