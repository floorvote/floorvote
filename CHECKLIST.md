# Open-core launch checklist

This file tracks pre- and post-commit steps for the public release. Delete it before going public (or move it to the BPC fork).

## Before first commit

- [x] Copy and sanitize source from the-tracker
- [x] Strip BPC patterns (floor.vote, thetracker.vote, bpc-elections, bipartisanpolicy, wadler)
- [x] Strip internal archaeology (superpowers, research, backlog, conductor, routines)
- [x] Strip finding/task IDs from code comments
- [x] Strip historical/migration notes from docs
- [x] Remove BPC production superadmin public key from committed files
- [x] Sanitize org-specific references (NJ/RI Association names)
- [x] Create wrangler.example.toml for api/ and central/; gitignore real wrangler.toml
- [x] Rewrite AGENTS.md as single source of instructions (deploy/develop split)
- [x] Rewrite self-hosting.md (LegiScan-first)
- [x] Sanitize and include spinning-up-instances.md
- [x] Create README.md, CONTRIBUTING.md, SECURITY.md, LICENSE, NOTICE
- [x] Legal doc placeholders (docs/legal/*.example.md)
- [x] VitePress docsite scaffold (config, landing page, sidebar)
- [x] Regenerate graphify-out/ from sanitized source
- [x] Gitleaks: no leaks
- [x] BPC pattern grep: zero hits
- [x] All tests pass (web, api, central)
- [x] VitePress builds clean
- [ ] Final review walkthrough
- [ ] Write commit message and `git init` + commit (manual)

## After first commit

- [ ] Create GitHub repo (`gh repo create floorvote/floorvote --private --source . --push`)
- [ ] Add `GEMINI_API_KEY` as a GitHub repo secret (Settings → Secrets → Actions) — enables named communities in the nightly graphify refresh
- [ ] Verify the graphify-refresh Action runs successfully (trigger manually or wait for nightly)
- [ ] Verify CI workflow runs on push

## Before going public

- [ ] Final secret scan on the repo (`gitleaks detect`)
- [ ] Review README provenance note (update commit count and date)
- [ ] Flip repo visibility to public
- [ ] Update GitHub repo link in VitePress config and README (currently points to floorvote/floorvote)

## BPC fork (deferred)

- [ ] Create private BPC fork from C0
- [ ] Add overlay commit C1 (real wrangler.toml, ops docs, backlog, conductor, deploy scripts)
- [ ] Disable graphify-refresh.yml in the fork (inherits graph from upstream)
- [ ] Set upstream remote; verify `git merge upstream/main` is clean
- [ ] Migrate working directory to BPC fork
- [ ] Archive the-tracker to personal GitHub (private, read-only)
