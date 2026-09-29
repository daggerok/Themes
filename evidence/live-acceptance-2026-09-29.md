# Themes ETFs isolated live acceptance — 2026-09-29

- **Revision:** `243bf3562448c8d381c5506d6e9623b499f30031`
- **Working copy:** detached `/tmp/themes-acceptance` worktree; generated `api/themes` stayed outside the feature checkout.
- **Provider configuration:** official Themes catalog and holdings CSV enabled; Yahoo chart/dividend history enabled; SEC EDGAR fallback enabled but not used; `REQUEST_SLEEP=1`, `CONCURRENCY=2`, `MAX_RETRIES=3`.
- **Command, run 1:** `TICKERS='BOTT,CLOD,AUMI' VERBOSE=1 REQUEST_SLEEP=1 CONCURRENCY=2 MAX_FETCHES=0 bun scripts/update-data.ts`
- **Command, run 2:** exactly the same command.
- **Timestamp:** 2026-09-29T05:41:46Z (run 2 completed before this evidence record was written).

## Run 1

Exit code: **0**. The official catalog contained 13 first-party Themes ETFs. All three requested tickers were selected and processed; no fund failed or was skipped:

| Ticker | Holdings rows | History rows | Dividend events | Official holdings source |
| --- | ---: | ---: | ---: | --- |
| AUMI | 35 | 699 | 2 | `https://themesetfs.com/storage/holdings/Holdings-AUMI.csv` |
| BOTT | 41 | 611 | 2 | `https://themesetfs.com/storage/holdings/Holdings-BOTT.csv` |
| CLOD | 57 | 697 | 1 | `https://themesetfs.com/storage/holdings/Holdings-CLOD.csv` |

The generated index had 13 catalog entries, 133 holdings rows, and 2,007 history rows. Only `AUMI`, `BOTT`, and `CLOD` fund directories were written; the remaining catalog funds stayed skeleton entries, so no unrequested fund data was modified. `live-acceptance-2026-09-29-run1.log`, `.summary`, `.files`, `.fund-dirs`, and `.sha256` contain the full command output, selected catalog summary, file list, and file hashes.

## Run 2 / idempotency

Exit code: **0**. All three selected funds reported `unchanged`; the updater reported zero updated funds, zero failures, and three unchanged funds. `cmp -s` confirmed that the complete run-1 and run-2 SHA-256 manifests are byte-identical. No timestamp-only rewrite occurred. The full output and the second hash manifest are tracked as `live-acceptance-2026-09-29-run2.log` and `live-acceptance-2026-09-29-run2.sha256`.

## Scope and provider result

The official Themes CSV and Yahoo paths were freshly fetched successfully for all requested funds. SEC EDGAR was not invoked because its fallback condition was not reached. The acceptance output was intentionally kept isolated from the production `api/themes` tree; it is evidence, not a publication of refreshed static data.
