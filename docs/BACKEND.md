# Backend Reference

FastAPI app entry point: `backend/main.py`.

## API Routes

### Auth

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/auth/login` | Username/password login |
| GET | `/api/auth/me` | Current authenticated user |
| GET | `/api/auth/mode` | Returns `{ multi_user: boolean }` |
| PUT | `/api/auth/mode` | Admin-only toggle for single-user vs multi-user mode |
| GET | `/api/auth/users` | Admin-only user list |
| POST | `/api/auth/users` | Admin-only user creation |
| PUT | `/api/auth/users/{user_id}` | Admin-only user update |
| DELETE | `/api/auth/users/{user_id}` | Admin-only user delete; cascades owned data cleanup |
| PUT | `/api/auth/me/password` | Change password with current password |
| PUT | `/api/auth/me/force-password` | Complete required first-login password change |
| PUT | `/api/auth/me/avatar` | Update current user's avatar |
| PUT | `/api/auth/me/username` | Update current user's profile name |

### Cards

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/cards/search` | Local card search |
| GET | `/api/cards/custom` | List the current user's custom cards and shared templates |
| POST | `/api/cards/custom` | Create an owner-scoped custom card |
| POST | `/api/cards/custom/{card_id}/clone` | Copy a shared template into an independent private card |
| PUT | `/api/cards/custom/{card_id}` | Owner-only custom-card update |
| DELETE | `/api/cards/custom/{card_id}` | Owner-only custom-card delete |
| GET | `/api/cards/custom/matches` | Pending custom-card migration matches |
| POST | `/api/cards/custom/migrate/{match_id}` | Migrate custom card to API card |
| POST | `/api/cards/custom/dismiss/{match_id}` | Dismiss match |
| GET | `/api/cards/{card_id}/lang/{lang}` | Resolve equivalent card in another language |
| GET | `/api/cards/{card_id}/price-history` | Price history |
| PUT | `/api/cards/{card_id}/custom-image` | Set temporary custom image URL |
| GET | `/api/cards/{card_id}` | Card detail |
| POST | `/api/cards/recognize` | Card recognition through the user's configured vision provider |
| POST | `/api/cards/recognize/jobs` | Sanitize and enqueue up to 50 persistent scan photos |
| GET | `/api/cards/recognize/jobs` | Current user's active/actionable scan jobs |
| GET | `/api/cards/recognize/jobs/{job_id}` | User-scoped scan job and review items |
| GET | `/api/cards/recognize/jobs/{job_id}/items/{item_id}/image` | Private sanitized review photo |
| POST | `/api/cards/recognize/jobs/{job_id}/items/{item_id}/resolve` | Confirm/dismiss an item and delete its queued photo |
| POST | `/api/cards/recognize/jobs/{job_id}/items/{item_id}/retry` | Retry one reviewable item individually |
| DELETE | `/api/cards/recognize/jobs/{job_id}` | Delete a job and its queued photos |

Custom cards belong to exactly one user. Owners may publish a card as a shared template, but other users must clone it before using it in collections, wishlists, binders, products, or trades. Clones have independent IDs, metadata, images, and prices. Manual image URLs must use public HTTPS destinations and are fetched through the size-limited image proxy. During upgrade, existing custom cards become shared templates owned by the first-created admin account, while each other referencing user receives one private clone and keeps their existing references.

### Collection, Sets, Wishlist, Binders

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/collection/` | User-scoped collection |
| GET | `/api/collection/user/{user_id}` | View another user's collection (read-only, auth required) |
| POST | `/api/collection/` | Add to collection |
| POST | `/api/collection/bulk-add` | Bulk-add selected cards; commits each item independently and reports added/updated/failed counts |
| POST | `/api/collection/import-csv` | Strict CSV collection import with all-or-nothing validation |
| PUT | `/api/collection/{item_id}` | Update collection item |
| DELETE | `/api/collection/{item_id}` | Delete collection item |
| GET | `/api/collection/stats/summary` | Collection summary |
| GET | `/api/sets/` | List sets |
| GET | `/api/sets/new` | Newly detected sets |
| POST | `/api/sets/mark-seen` | Mark new-set badges seen |
| GET | `/api/sets/{set_id}` | Set detail |
| GET | `/api/sets/{set_id}/checklist` | Set checklist |
| GET | `/api/wishlist/` | Wishlist |
| POST | `/api/wishlist/` | Add wishlist item |
| PUT | `/api/wishlist/{item_id}` | Update wishlist quantity and price alerts |
| DELETE | `/api/wishlist/{item_id}` | Remove wishlist item |
| GET | `/api/binders/` | Binders |
| POST | `/api/binders/` | Create binder |
| PUT | `/api/binders/{binder_id}` | Update binder |
| DELETE | `/api/binders/{binder_id}` | Delete binder |
| GET | `/api/binders/{binder_id}/cards` | Binder cards |
| GET | `/api/binders/{binder_id}/optimize-prints` | Equivalent-print optimization preview |
| POST | `/api/binders/{binder_id}/optimize-prints` | Apply equivalent-print optimization |
| POST | `/api/binders/{binder_id}/cards` | Add card to binder |
| POST | `/api/binders/{binder_id}/collection-items` | Add owned collection item to binder |
| PUT | `/api/binders/{binder_id}/entries/{binder_card_id}` | Update binder entry quantity |
| GET | `/api/binders/{binder_id}/entries/{binder_card_id}/equivalent-prints` | List equivalent prints for an entry |
| PUT | `/api/binders/{binder_id}/entries/{binder_card_id}/card` | Switch an entry to an equivalent print |
| POST | `/api/binders/{binder_id}/entries/{binder_card_id}/wishlist` | Move binder entry to wishlist |
| POST | `/api/binders/{binder_id}/wishlist` | Add wishlist card to binder |
| GET | `/api/binders/{binder_id}/export-csv` | Binder CSV export |
| POST | `/api/binders/{binder_id}/import-csv` | Binder CSV import |
| DELETE | `/api/binders/{binder_id}/entries/{binder_card_id}` | Remove binder entry |
| DELETE | `/api/binders/{binder_id}/cards/{card_id}` | Remove card from binder |

### Dashboard, Analytics, Social, Community

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/dashboard/` | Dashboard summary |
| GET | `/api/analytics/duplicates` | Duplicate cards |
| GET | `/api/analytics/top-movers` | Price movers |
| GET | `/api/analytics/rarity-stats` | Rarity distribution |
| GET | `/api/analytics/investment-tracker` | Portfolio history |
| GET | `/api/analytics/new-sets` | Analytics new sets |
| GET | `/api/social/leaderboard` | Multi-user leaderboard |
| GET | `/api/social/compare/{user_id}` | Multi-user comparison |
| GET | `/api/social/achievements/{user_id}` | Achievement progress |
| GET | `/api/github/contributors` | Public GitHub contributors feed |
| GET | `/api/github/supporters` | Supporters from `SUPPORTERS.csv` |
| GET | `/api/github/rescue-donations` | Rescue donation total from `RESCUE_DONATIONS.csv` |

### Products, Export, Backup, Sync, Settings

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/products/types` | Product type suggestions |
| GET | `/api/products/` | Product list |
| POST | `/api/products/` | Create product |
| PUT | `/api/products/{product_id}` | Update product |
| DELETE | `/api/products/{product_id}` | Delete product |
| GET | `/api/products/summary` | Product summary |
| GET | `/api/products/{product_id}` | Product detail |
| POST | `/api/products/{product_id}/cards` | Link collection cards to product |
| DELETE | `/api/products/{product_id}/cards/{product_card_id}` | Unlink product card |
| POST | `/api/products/{product_id}/cards/{product_card_id}/sell` | Record product-card sale |
| POST | `/api/products/{product_id}/ledger` | Add product ledger entry |
| GET | `/api/export/csv` | CSV export |
| GET | `/api/export/pdf` | PDF export |
| GET | `/api/backup/download` | Admin-only SQL backup |
| POST | `/api/backup/restore` | Admin-only SQL restore |
| POST | `/api/backup/clear-image-cache` | Admin-only image cache clear |
| POST | `/api/sync/` | Admin-only full sync |
| POST | `/api/sync/prices` | Admin-only small price sync |
| POST | `/api/sync/prices/all` | Admin-only forced price sync for all tracked cards |
| POST | `/api/sync/reschedule-full` | Reschedule full sync |
| POST | `/api/sync/reschedule-prices` | Reschedule price sync |
| GET | `/api/sync/status` | Sync status and history |
| GET | `/api/images/card/{card_id}/{size}` | Card image proxy/cache |
| GET | `/api/images/set/{set_id}/{image_type}` | Set logo/symbol proxy/cache |
| GET | `/api/settings/` | Effective settings for current user |
| GET | `/api/settings/scanner` | Typed provider/model readiness for the current user |
| PUT | `/api/settings/scanner` | Save an already-verified scanner configuration or remove a key |
| POST | `/api/settings/scanner/test` | Two-image capability test with optional atomic save |
| GET | `/api/settings/tcgdex-languages` | Supported TCGdex language metadata |
| PUT | `/api/settings/` | Update settings |
| GET | `/api/settings/debug-log` | Admin-only debug log download |
| DELETE | `/api/settings/scan-diagnostics` | Delete all persisted scanner diagnostics for the current user |
| GET | `/api/settings/telegram_status` | Whether Telegram is configured for current user |
| GET | `/api/settings/exchange-rate` | Exchange-rate lookup for display currency |
| GET | `/api/settings/{key}` | Get one setting |
| POST | `/api/settings/{key}` | Set one setting |

## Models

### `Card`

- Composite primary key: `{tcg_card_id}_{lang}`, for example `sv1-1_de`
- `tcg_card_id` stores the original TCGdex card id
- `set_id` stores the original TCGdex set id, not the composite set row id
- `rarity` is read-only API data
- Variant availability is represented by boolean flags:
  - `variants_normal`
  - `variants_reverse`
  - `variants_holo`
  - `variants_first_edition`

### `CollectionItem`

- Stores user-owned copies of cards
- Active fields: `card_id`, `user_id`, `quantity`, `condition`, `variant`, `purchase_price`, `lang`
- Variant values are now the physical print variants only: `Normal`, `Holo`, `Reverse Holo`, `First Edition`
- The old grading UI is gone; the database migration history still contains a legacy `grade` column, but it is not part of the current ORM model or API schema
- Existing rows are grouped by user, card, variant, language, condition, and purchase price when cards are added through the API

### `User`

- Fields include `role`, `avatar_id`, and `must_change_password`
- `must_change_password` is returned by auth responses and enforced by the frontend after login

### `Setting`

- Global key/value table
- Used for admin-only settings such as sync cadence and auth mode

### `UserSetting`

- Per-user key/value table
- Used for isolated user preferences and secrets
- Unique constraint: `user_id + key`

### Other Core Models

- `Set`
- `WishlistItem`
- `Binder` / `BinderCard`
- `ProductPurchase`
- `PriceHistory`
- `PortfolioSnapshot`
- `SyncLog`
- `ImageCache`
- `CustomCardMatch`

## Settings Scope

Current settings are split in `backend/api/settings.py`:

- `PER_USER_KEYS`
  - `language`
  - `currency`
  - `price_primary`
  - `price_display`
  - `telegram_bot_token`
  - `telegram_chat_id`
  - `telegram_enabled`
  - `price_alerts_enabled`
  - `price_alert_threshold`
  - `gemini_api_key`
  - `openai_api_key`
  - provider-specific scanner provider/model settings managed by the dedicated scanner endpoint
  - `scan_diagnostics_enabled`
  - `trainer_name`
- `ADMIN_ONLY_KEYS`
  - `full_sync_interval_days`
  - `price_sync_interval_minutes`
  - `multi_user_mode`
  - `tcgdex_sync_languages`
  - `debug_mode`
  - `cross_language_price_fallback`
  - `cross_language_image_fallback`

Important behavior:

- Each user only reads and writes their own `UserSetting` rows
- Admin-only settings are stored globally in `settings`
- Recurring automatic syncs include a full sync cadence and a separate small price sync cadence
- `tcgdex_sync_languages` is seeded from `TCGDEX_SYNC_LANGUAGES` only when the row does not exist yet; afterward the DB value is authoritative. Empty or invalid env values safely fall back to `en,de`. The env value `all` expands to every supported TCGdex language during first bootstrap.
- Supported TCGdex sync language codes are centralized in `services/tcgdex_languages.py`. Optional extra languages are `fr`, `es`, `es-mx`, `it`, `pt`, `pt-br`, `pt-pt`, `nl`, `pl`, `ru`, `ja`, `ko`, `zh-tw`, `id`, `th`, and `zh-cn` in addition to the default `en,de`.
- English is the preferred cross-language fallback source for missing data, images, and prices by exact TCGdex ID. The backend does not guess English replacements by card name for regional-only cards.
- Admin users can receive initial fallback values from env vars for Telegram and Gemini
- `recognize.py` intentionally reads Gemini only from the current user's `UserSetting`; there is no cross-user fallback
- `scan_diagnostics_enabled` is off by default and is effective only when the server configures `SCAN_TRACE_DIR`

## Sync & Backup Behavior

### Sync

- `/api/sync/`, `/api/sync/prices`, and `/api/sync/prices/all` enforce admin access
- `/api/sync/` runs the full TCGdex set/card sync using the configured `tcgdex_sync_languages`
- `/api/sync/prices` runs the small tracked-card price sync
- `/api/sync/prices/all` force-refreshes prices for all tracked cards
- Sync status returns current flags plus the last 10 sync log rows
- Full sync and price sync can be rescheduled through dedicated endpoints

### Selective Backup

`GET /api/backup/download` accepts `include` as a comma-separated query param.

Supported groups:

- `full`
- `collection`
- `users`
- `cards`
- `products`
- `system`
- `images`

Current table mapping:

- `collection`: `collection`, `wishlist`, `binders`, `binder_cards`
- `users`: `users`, `user_settings`, `settings`
- `cards`: `cards`, `sets`, `price_history`, `custom_card_matches`
- `products`: `product_purchases`, `portfolio_snapshots`
- `system`: `sync_log`
- `images`: `image_cache`

If `include=full`, image cache is excluded unless `images` is also explicitly included.

### Automatic Pre-upgrade Backup

The backend image installs PostgreSQL 18 client tools so `pg_dump` can back up the default PostgreSQL 18 service and newer external PostgreSQL 18 servers. PostgreSQL requires `pg_dump` to be at least as new as the server major version.

`backend/services/pre_upgrade_backup.py` runs before `init_db()` startup migrations.

Behavior:

- Reads the current app version from `VERSION` through `backend/main.py`.
- Reads `settings.last_successful_app_version` from the existing database.
- Skips fresh installs where the `settings` table does not exist yet.
- Creates a full SQL dump in `/app/backups` when an existing install starts on a new version.
- Uses filenames like `pre_upgrade_1.17.0_to_1.18.0_20260526_010500.sql`.
- Records `last_successful_app_version` only after startup initialization succeeds.
- Retains the newest `PRE_UPGRADE_BACKUP_KEEP` automatic backups, default `10`, minimum `1`.
- Writes dumps to a temporary filename first, then atomically renames after a successful non-empty `pg_dump` so partial files are not treated as valid backups.

Environment controls:

- `PRE_UPGRADE_BACKUP_ENABLED`, default `true`
- `PRE_UPGRADE_BACKUP_REQUIRED`, default `true`; when true, startup fails before migrations if `pg_dump` fails
- `PRE_UPGRADE_BACKUP_KEEP`, default `10`, minimum `1`

## Scanner Notes

`backend/api/recognize.py`, `backend/api/scan_jobs.py`, and `backend/services/scan_queue.py` implement the persistent background queue used by the unified scanner. The direct single-card recognition endpoint remains available for API compatibility:

1. Uploads are bounded, sanitized, orientation-normalized JPEGs with metadata removed.
2. Two-to-four batch-eligible photos share one indexed composite provider request. Any missing or uncertain position is retried from its original individual photo.
3. The selected provider extracts name, split local/total collector number, printed set code, regulation mark, type, HP, language, and artist; uncertain small text stays `null`.
4. TCGdex candidates are ranked deterministically by local number, language, printed total, set code, regulation mark, artist, and HP. Missing evidence is neutral and contradictions are negative.
5. If metadata is inconclusive, conservative pHash can accept a close, clearly separated visual winner without another provider call. It never overrides known contradictions.
6. Individual scans may use the same provider's visual comparison when pHash abstains; composite scans fall back to individual recognition instead.
7. Queue results remain reviewable after restarts. Confirming/dismissing an item deletes its queued photo; unreviewed jobs expire after 14 days.

Provider error handling:

- Gemini and OpenAI-compatible providers share the queue contract while retaining provider-specific request formats
- Permanent authentication, billing, model, and request errors stop immediately with fixed actionable messages; arbitrary upstream prose is not returned, logged, or persisted
- Transient provider failures are retried with bounded backoff
- Machine-readable daily-quota `429` responses are separated from short-term limits
- Provider `Retry-After` or `google.rpc.RetryInfo` delays are used exactly when supplied; missing daily delays fall back to one hour and later six-hour intervals
- Quota state is shared by an API-key fingerprint, so concurrent requests using the same key observe one block while different keys stay independent
- Quota retries do not consume the three recognition attempts
- Invalid API keys get a dedicated user-facing message
- Provider defaults and approved models are administrator-controlled; normal users select only enabled choices, while administrators may test an Advanced custom model
- Retired or unavailable models return a fixed model-unavailable message without reflecting provider text
- Temporary Gemini outages are returned clearly instead of leaking as generic backend `500` errors
- Gemini requests send the API key via header instead of the request URL

Additional matching behavior:

- Name suffixes like `EX`, `GX`, `V`, `VMAX`, `VSTAR`, `TAG TEAM`, `BREAK`, and `LV.X` are stripped before search
- Search may fall back from detected card language to English
- Result payload includes recognized metadata and candidate matches

### Scanner diagnostics

`backend/services/scan_trace.py` is disabled unless `SCAN_TRACE_DIR` points to storage the backend can create and write. Availability alone does not collect data: each user must opt in with `scan_diagnostics_enabled=true`, which is off by default. `SCAN_TRACE_STORAGE_DIR` is the stable cleanup location; standard Docker Compose keeps it at `/app/data/scan-traces` even when new collection is disabled.

For opted-in attempts, one user-scoped JSON trace and sanitized JPEG are stored. Traces contain the selected provider and model, generic prompt, redacted provider response, parsed fields and usage, TCGdex searches, ranked candidates and rank keys, pHash distances, visual-verification response, final mechanism, and errors. Configured credentials are redacted before persistence and are never returned by the settings API.

When a queued candidate is confirmed, its TCGdex card id labels all stored attempts for that job item as ground truth. `backend/scripts/analyse_scan_traces.py` reports top-1 accuracy, retrieval/ranking misses, decision-mechanism performance, pHash outcomes, and optional field-null/failure details.

Turning consent off stops future capture and leaves existing traces unchanged. There is no automatic retention limit. `DELETE /api/settings/scan-diagnostics` is the explicit per-user deletion action; deleting an account revokes in-flight writes and removes its trace subtree as well. Trace directories use mode `0700` and JSON/JPEG files use `0600`. Diagnostics are not included in SQL backups because they are filesystem analysis data.

## Bulk Collection Add

`POST /api/collection/bulk-add` accepts `BulkCollectionAddRequest` with multiple `CollectionItemCreate` items and returns `BulkCollectionAddResponse`:

- `added`: new collection rows created
- `updated`: existing matching rows whose quantity was incremented
- `failed`: items that could not be added
- `errors`: per-card error details

Each item is committed independently, so one invalid or unavailable card does not roll back the rest of the batch. Existing rows are matched by card, variant, language, and current user.

## Notifications

`backend/services/telegram.py` now accepts `user_id` and reads Telegram credentials from that user's `UserSetting` rows first.

## Migrations

- Migrations are raw SQL statements in `backend/database.py`
- They are idempotent and run on startup
- Automatic pre-upgrade backups run before `init_db()` migrations on existing installs when the app version changes
- Legacy migration comments still mention older columns like `grade` or removed integrations, but the current runtime model and routers do not include eBay functionality
