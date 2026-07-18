# OpenStates scripts

These scripts belong to **the OpenStates self-hosting path**. They're kept for reference and for self-hosters using the OpenStates central env.

## What's here

| Script | Purpose | Status |
|---|---|---|
| `seed-from-bulk.ts` | Seed the OS central D1 from an OpenStates bulk JSON download | Functional, OS-only |
| `load-history.ts` | Download LegiScan datasets *but write to the **OS central*** D1 (`central-bills`, not `central-bills-ls`). Legacy hybrid from before the LegiScan path stabilized. | Legacy — likely broken against current schema |
| `openstates-eval.ts` | Early evaluation script comparing OpenStates as a data source against LegiScan | Eval / one-off |
| `openstates-deep-eval.ts` | Deeper version of the above | Eval / one-off |
| `openstates-crossref.py` | Python cross-reference helper for the eval | Eval / one-off |

## Why they're here

Two centrals exist as separate wrangler environments in `central/`:
- The **legiscan** env (`floorvote-central-legiscan`) is the production path.
- The default env (`floorvote-central`) is the OpenStates path for self-hosters. Lighter, less actively maintained.

The LegiScan-side seeding lives in the parent directory (`scripts/seed-legiscan.ts`).

See `docs/internal/sync-pipeline.md` for the canonical pipeline description.
