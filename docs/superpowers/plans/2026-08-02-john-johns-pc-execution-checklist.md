# John John's PC Execution Checklist

Date: 2026-08-02

Source plan:

- `V:\workspaces\projects\john-johns-pc\docs\superpowers\plans\2026-08-02-john-johns-pc-authoritative-implementation-plan.md`

Purpose:

Execute the authoritative plan in small, reviewable steps against the already-dirty `fix/design-system-tokens` branch.

Rule:

Treat existing uncommitted work as user/project work. Do not reset, clean, delete, or broad-format. Patch only the files required by the failing check currently being addressed.

## Phase 0 — Workspace safety and baseline

- [ ] Confirm branch and dirty tree.

  ```powershell
  git -C "V:\workspaces\projects\john-johns-pc" status --short --branch
  ```

- [ ] Confirm local app routes and backend health if already running.

  ```powershell
  Invoke-WebRequest http://127.0.0.1:13000 -UseBasicParsing | Select-Object -ExpandProperty StatusCode
  Invoke-WebRequest http://127.0.0.1:18080/api/health -UseBasicParsing | Select-Object -ExpandProperty Content
  ```

- [ ] Confirm authoritative plan exists.

  ```powershell
  Get-Item "V:\workspaces\projects\john-johns-pc\docs\superpowers\plans\2026-08-02-john-johns-pc-authoritative-implementation-plan.md"
  ```

- [ ] Do not commit until the user explicitly asks.

## Phase 1 — Product identity and primary navigation

Goal:

The visible product shell is **John John's PC** with exactly five primary navigation destinations.

Checks:

- [ ] Run focused identity/navigation tests.

  ```powershell
  npm --prefix "V:\workspaces\projects\john-johns-pc\frontend" test -- App.metadata.test.jsx Collection.firstRelease.test.jsx Settings.firstRelease.test.jsx --run
  ```

- [ ] If tests fail, inspect only the relevant shell/nav files:

  - `frontend/src/App.jsx`
  - `frontend/src/components/ArchiveShell.jsx`
  - `frontend/src/pages/Home.jsx`
  - `frontend/src/pages/Collection.jsx`
  - `frontend/index.html`
  - `frontend/public/manifest.json`

- [ ] Patch to enforce:

  - Product name: `John John's PC`
  - Primary nav: `Collection`, `Card Search`, `All Cards`, `Trends & Insights`, `Settings`
  - Collection heading: `My Collection`
  - Compact mark: `∞`
  - No visible `Dashboard`, `Analytics`, `Sets`, or `Wishlist` as primary product language

- [ ] Re-run focused tests.

- [ ] Re-run frontend build after any code patch.

  ```powershell
  npm --prefix "V:\workspaces\projects\john-johns-pc\frontend" run build
  ```

## Phase 2 — Design system and motion requirements

Goal:

John John's PC has one desktop dark motion-forward mode. There is no reduced-motion product setting.

Checks:

- [ ] Search for stale reduced-motion setting and stale visual-mode copy.

  ```powershell
  rg -n "Reduce Motion|reduced motion|prefers-reduced-motion|motion toggle|light mode|theme toggle" "V:\workspaces\projects\john-johns-pc\frontend" "V:\workspaces\projects\john-johns-pc\docs" "V:\workspaces\projects\john-johns-pc\README.md"
  ```

- [ ] Run Settings and first-release language tests.

  ```powershell
  npm --prefix "V:\workspaces\projects\john-johns-pc\frontend" test -- Settings.firstRelease.test.jsx firstReleaseLanguage.test.js --run
  ```

- [ ] If stale reduced-motion product controls exist, remove the visible setting and docs language.

- [ ] Preserve meaningful motion classes/components where they communicate loading, discovery, presence, card hover, or collection reveal.

- [ ] Re-run focused tests and build.

## Phase 3 — Collection Lots and card care

Goal:

Owned cards are tracked as collection lots with practical provenance, condition, protection, cost basis, notes, and creator media.

Checks:

- [ ] Run backend collection metadata tests.

  ```powershell
  pytest "V:\workspaces\projects\john-johns-pc\backend\tests\test_collection_metadata.py" "V:\workspaces\projects\john-johns-pc\backend\tests\test_collection_lot_media.py" -v
  ```

- [ ] Run frontend collection tests.

  ```powershell
  npm --prefix "V:\workspaces\projects\john-johns-pc\frontend" test -- Collection.firstRelease.test.jsx Collection.creatorMedia.test.jsx CardItem.collectionLot.test.jsx --run
  ```

- [ ] If tests fail, patch only relevant collection-lot module files:

  - `backend/models.py`
  - `backend/database.py`
  - `backend/schemas.py`
  - `backend/api/collection.py`
  - `frontend/src/pages/Collection.jsx`
  - `frontend/src/components/CardItem.jsx`
  - `frontend/src/components/CardListItem.jsx`

- [ ] Enforce:

  - Conditions: `NM`, `LP`, `MP`, `HP`, `DMG`
  - Intents: `Main Collection`, `Vault`, `PC`
  - Chase states: `Track`, `Chase`, `Grail`
  - Grails use star marker
  - Corrections can overwrite
  - Creator is always the user
  - Media supports primary photo plus Instagram/Pinterest/Reels references

- [ ] Re-run focused tests.

## Phase 4 — Acquisition and cost basis

Goal:

Cost basis behavior is consistent and not reimplemented across callers.

Checks:

- [ ] Run cost-basis and analytics tests.

  ```powershell
  pytest "V:\workspaces\projects\john-johns-pc\backend\tests\test_analytics.py" "V:\workspaces\projects\john-johns-pc\backend\tests\test_product_ledger.py" -v
  npm --prefix "V:\workspaces\projects\john-johns-pc\frontend" test -- Analytics.visualize.test.jsx Products.firstRelease.test.jsx --run
  ```

- [ ] If tests fail, patch the backend calculation module before patching UI labels:

  - `backend/services/analytics.py`
  - `backend/api/analytics.py`
  - `backend/api/products.py`
  - `frontend/src/pages/Analytics.jsx`
  - `frontend/src/pages/Products.jsx`

- [ ] Enforce:

  - Pulled-from-pack default cost basis: `$4.49`
  - Missing basis label: `Cost Basis Needed`
  - Missing basis included in market value
  - Missing basis excluded from profit/loss
  - No financial context on Collection page
  - No JOMW Fund references

- [ ] Re-run focused tests.

## Phase 5 — Sealed product

Goal:

Sealed product is separate from card lots and can participate in Trends & Insights only when marked Vault or PC.

Checks:

- [ ] Run sealed-product tests.

  ```powershell
  pytest "V:\workspaces\projects\john-johns-pc\backend\tests\test_product_storage.py" "V:\workspaces\projects\john-johns-pc\backend\tests\test_product_ledger.py" -v
  npm --prefix "V:\workspaces\projects\john-johns-pc\frontend" test -- Products.firstRelease.test.jsx --run
  ```

- [ ] If tests fail, patch:

  - `backend/models.py`
  - `backend/database.py`
  - `backend/schemas.py`
  - `backend/api/products.py`
  - `frontend/src/pages/Products.jsx`
  - `frontend/src/components/SealedCollectionView.jsx`

- [ ] Enforce:

  - Sealed records are not card lots
  - Quantity is tracked
  - Acquisition source is tracked
  - Collection intent is tracked
  - Cost basis is optional
  - Storage/protection note is supported
  - Vault/PC sealed product can appear in portfolio scope

- [ ] Re-run focused tests.

## Phase 6 — Card Search discovery

Goal:

Card Search is the full catalog and discovery surface.

Checks:

- [ ] Run focused Card Search tests.

  ```powershell
  npm --prefix "V:\workspaces\projects\john-johns-pc\frontend" test -- CardSearch.fullCatalog.test.jsx CardSearch.discovery.test.jsx --run
  ```

- [ ] Search for forbidden discovery language.

  ```powershell
  rg -n "Featured Expansions|Discovery Pulse|Pokemon\\.com|Pokémon\\.com" "V:\workspaces\projects\john-johns-pc\frontend" "V:\workspaces\projects\john-johns-pc\docs" "V:\workspaces\projects\john-johns-pc\README.md"
  ```

- [ ] If tests/search fail, patch:

  - `frontend/src/pages/CardSearch.jsx`
  - `frontend/src/pages/Discover.jsx`
  - `frontend/src/utils/archiveInsights.js`
  - `frontend/src/api/client.js`

- [ ] Enforce:

  - Opens to full catalog
  - Owned Only toggle
  - Add to Collection action
  - Discovery rail labels:
    - `New Set Drops`
    - `Meta & Deckbuilding`
    - `Trending Cards`
  - PokéBeach only for current discovery implementation
  - Bulbapedia copy uses `In Animation`
  - Subheading format: `Featured In {{TITLE}}`
  - JustWatch copy: `Currently available on [#] streaming services.`

- [ ] Re-run focused tests and build.

## Phase 7 — All Cards and Chase Cards

Goal:

All Cards is the master catalog/completion surface, and Chase Cards replaces Wishlist in user-facing language.

Checks:

- [ ] Run focused tests.

  ```powershell
  npm --prefix "V:\workspaces\projects\john-johns-pc\frontend" test -- Sets.firstRelease.test.jsx SetDetail.chaseCards.test.jsx Discover.chaseCards.test.jsx chaseCardsLanguage.test.js --run
  pytest "V:\workspaces\projects\john-johns-pc\backend\tests\test_wishlist_api.py" "V:\workspaces\projects\john-johns-pc\backend\tests\test_wishlist_missing.py" -v
  ```

- [ ] Search visible language.

  ```powershell
  rg -n "Wishlist|Master Set|Sets|Analytics" "V:\workspaces\projects\john-johns-pc\frontend\src" "V:\workspaces\projects\john-johns-pc\docs" "V:\workspaces\projects\john-johns-pc\README.md"
  ```

- [ ] Keep backend legacy wishlist route if required, but user-facing UI must say `Chase Cards`.

- [ ] Re-run focused tests.

## Phase 8 — Trends & Insights

Goal:

Trends & Insights exposes Visualize, Discover, Master Set, and Portfolio Performance with correct scope.

Checks:

- [ ] Run focused Trends & Insights tests.

  ```powershell
  npm --prefix "V:\workspaces\projects\john-johns-pc\frontend" test -- Analytics.visualize.test.jsx --run
  pytest "V:\workspaces\projects\john-johns-pc\backend\tests\test_analytics.py" -v
  ```

- [ ] Patch only if checks fail:

  - `frontend/src/pages/Analytics.jsx`
  - `backend/services/analytics.py`
  - `backend/api/analytics.py`

- [ ] Enforce sections:

  - Visualize
  - Discover
  - Master Set
  - Portfolio Performance

- [ ] Enforce portfolio scope:

  - Vault
  - PC
  - Top 5-10% by market value in Main Collection
  - Separate card and sealed-product counts
  - No JOMW Fund wording

- [ ] Re-run focused tests and build.

## Phase 9 — Scan history and local-first recognition

Goal:

HoloDex-style phone scanning/AI grading references do not imply ownership, and scan history is retained locally for 14 days.

Checks:

- [ ] Run scan/local-first tests.

  ```powershell
  pytest "V:\workspaces\projects\john-johns-pc\backend\tests\test_scan_history.py" "V:\workspaces\projects\john-johns-pc\backend\tests\test_recognize_local_first.py" "V:\workspaces\projects\john-johns-pc\backend\tests\test_agent_local_only.py" -v
  npm --prefix "V:\workspaces\projects\john-johns-pc\frontend" test -- CardScanner.localFirst.test.jsx CardScanner.scanHistory.test.jsx --run
  ```

- [ ] If tests fail, patch:

  - `backend/api/recognize.py`
  - `backend/services/agent.py`
  - `frontend/src/components/CardScanner.jsx`
  - `frontend/src/pages/Settings.jsx`

- [ ] Enforce:

  - External AI disabled by default
  - No automatic ownership from scans
  - Scan history retained 14 days

- [ ] Re-run focused tests.

## Phase 10 — Excel export and backups

Goal:

Excel `.xlsx` is the official portable backup format, compatible with the GFS backup scheme.

Checks:

- [ ] Run export and backup tests.

  ```powershell
  pytest "V:\workspaces\projects\john-johns-pc\backend\tests\test_excel_export.py" "V:\workspaces\projects\john-johns-pc\backend\tests\test_weekly_excel_backup.py" "V:\workspaces\projects\john-johns-pc\backend\tests\test_scheduler_excel_backup_deferred.py" -v
  npm --prefix "V:\workspaces\projects\john-johns-pc\frontend" test -- ImportReviewNotice.test.jsx --run
  ```

- [ ] If tests fail, patch:

  - `backend/api/export.py`
  - `backend/services/inventory_workbook.py`
  - `backend/services/weekly_excel_backup.py`
  - `frontend/src/api/client.js`
  - `frontend/src/components/ImportReviewNotice.jsx`
  - `frontend/src/pages/Collection.jsx`

- [ ] Enforce:

  - Workbook includes Cards, Sealed Product, Acquisition & Storage
  - Export excludes credentials/tokens/unnecessary email body content
  - Backup path pattern: `C:\Users\%USERNAME%\OneDrive\John John's PC`
  - GFS backup scheme documented or represented
  - Imports are reviewed/manual, not automatic overwrites

- [ ] Re-run focused tests.

## Phase 11 — Documentation and final language sweep

Goal:

Docs match current product decisions.

Checks:

- [ ] Search stale terms.

  ```powershell
  rg -n "Pokemon TCG Tracker|Pokémon TCG Tracker|Dashboard|Wishlist|Featured Expansions|Discovery Pulse|Pokemon\\.com|Pokémon\\.com|Reduce Motion|reduced motion|JOMW FUND|private equity" "V:\workspaces\projects\john-johns-pc\README.md" "V:\workspaces\projects\john-johns-pc\docs" "V:\workspaces\projects\john-johns-pc\frontend\src"
  ```

- [ ] Patch docs/UI copy only where results are current-product visible and stale.

- [ ] Keep historical notes only if clearly marked as historical.

## Phase 12 — Full verification

- [ ] Run full frontend tests.

  ```powershell
  npm --prefix "V:\workspaces\projects\john-johns-pc\frontend" test -- --run
  ```

- [ ] Run frontend build.

  ```powershell
  npm --prefix "V:\workspaces\projects\john-johns-pc\frontend" run build
  ```

- [ ] Run backend tests.

  ```powershell
  pytest "V:\workspaces\projects\john-johns-pc\backend\tests" -v
  ```

- [ ] Build and restart local Docker stack.

  ```powershell
  docker compose -f "V:\workspaces\projects\john-johns-pc\docker-compose.yml" -f "V:\workspaces\projects\john-johns-pc\docker-compose.local.yml" build backend frontend
  docker compose -f "V:\workspaces\projects\john-johns-pc\docker-compose.yml" -f "V:\workspaces\projects\john-johns-pc\docker-compose.local.yml" up -d backend frontend
  ```

- [ ] Smoke local app.

  ```powershell
  Invoke-WebRequest http://127.0.0.1:13000 -UseBasicParsing | Select-Object -ExpandProperty StatusCode
  Invoke-WebRequest http://127.0.0.1:18080/api/health -UseBasicParsing | Select-Object -ExpandProperty Content
  ```

- [ ] Manually inspect:

  - `http://127.0.0.1:13000/collection`
  - `http://127.0.0.1:13000/card-search`
  - `http://127.0.0.1:13000/all-cards`
  - `http://127.0.0.1:13000/trends`
  - `http://127.0.0.1:13000/settings`

## Stop conditions

Stop and ask before continuing if:

- A test failure indicates schema/data loss risk.
- A required patch would overwrite unrelated dirty work.
- Docker build/restart would interrupt a process the user has not allowed.
- A requirement conflicts with the authoritative plan.
- A verification fails twice for the same root cause.

## Completion report format

When done, report:

- Files changed in this pass.
- Focused checks passed.
- Full checks passed.
- Docker/local smoke result.
- Known remaining gaps.
- Exact local URL to review.

