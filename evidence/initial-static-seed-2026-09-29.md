# Themes ETFs initial static API seed — 2026-09-29

- **Revision:** `042eccb31e6e` (`feat(ui): add Themes ETF watchlist client`)
- **Deliberate publication scope:** initial data seed for the static browser app. This is separate from the earlier isolated acceptance output.
- **Live command, first run:** `VERBOSE=1 REQUEST_SLEEP=1 CONCURRENCY=2 MAX_FETCHES=0 bun scripts/update-data.ts`
- **Live command, second run:** exactly the same command.
- **Provider configuration:** official Themes catalog/direct daily holdings CSV enabled, Yahoo chart/dividend path enabled, SEC N-PORT-P fallback enabled but not invoked, `MAX_RETRIES=3`.

## Seed result

Both commands exited with status **0**. The official catalog returned 13 first-party funds. Direct official daily CSV downloads succeeded for every catalog ticker before the seed and the updater reported zero failures:

`AGMI, AUMI, BOTT, CLOD, COPA, GSIB, LGCF, LIMI, NATO, SMCF, SPAM, URAN, WISE`

The initial committed feed contains 13 fund directories and 40 JSON files:

- **727** holdings rows
- **6,224** history rows
- **13** catalog entries

LGCF, LIMI, and SMCF currently have five Yahoo history rows, which is preserved as freshly fetched provider coverage rather than padded or inferred history.

## Idempotency and manifest checks

On the immediate repeat run, all 13 funds reported `unchanged`; the updater reported zero updates and zero failures. The SHA-256 manifests in `initial-static-seed-2026-09-29.sha256` and `initial-static-seed-2026-09-29-rerun.sha256` were compared with `cmp -s` and are byte-identical.

A local manifest consistency check verified that each catalog fund's `holdings` and `history` counts equal its `meta.json` manifests and that index totals equal the sum across all funds.

## Served-app smoke

The static repository was served at port 4173 and returned HTTP 200 for `/`, `/app.tsx`, `/api/themes/index.json`, BOTT metadata, and BOTT holdings page 001. A served API read confirmed all 13 funds and the required BOTT/CLOD/AUMI catalog entries. Browser-target transpilation and the offline header/selection interaction regression guards are recorded in the UI checkpoint; no browser executable is installed in this workspace, so those interaction paths are guarded structurally rather than by a headless-browser run.

The complete first/second updater logs, summaries, and checksum manifests sit alongside this record.
