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
| GET | `/api/cards/custom` | List custom cards |
| POST | `/api/cards/custom` | Create custom card |
| PUT | `/api/cards/custom/{card_id}` | Update custom card |
| DELETE | `/api/cards/custom/{card_id}` | Delete custom card |
| GET | `/api/cards/custom/matches` | Pending custom-card migration matches |
| POST | `/api/cards/custom/migrate/{match_id}` | Migrate custom card to API card |
| POST | `/api/cards/custom/dismiss/{match_id}` | Dismiss match |
| GET | `/api/cards/{card_id}/lang/{lang}` | Resolve equivalent card in another language |
| GET | `/api/cards/{card_id}/price-history` | Price history |
| GET | `/api/cards/{card_id}` | Card detail |
| POST | `/api/cards/recognize` | Gemini-powered card recognition |

### Collection, Sets, Wishlist, Binders

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/collection/` | User-scoped collection |
| GET | `/api/collection/user/{user_id}` | View another user's collection (read-only, auth required) |
| POST | `/api/collection/` | Add to collection |
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
| PUT | `/api/wishlist/{item_id}` | Update price alerts |
| DELETE | `/api/wishlist/{item_id}` | Remove wishlist item |
| GET | `/api/binders/` | Binders |
| POST | `/api/binders/` | Create binder |
| PUT | `/api/binders/{binder_id}` | Update binder |
| DELETE | `/api/binders/{binder_id}` | Delete binder |
| GET | `/api/binders/{binder_id}/cards` | Binder cards |
| POST | `/api/binders/{binder_id}/cards` | Add card to binder |
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

### Products, Export, Backup, Sync, Settings

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/products/types` | Product type suggestions |
| GET | `/api/products/` | Product list |
| POST | `/api/products/` | Create product |
| PUT | `/api/products/{product_id}` | Update product |
| DELETE | `/api/products/{product_id}` | Delete product |
| GET | `/api/products/summary` | Product summary |
| GET | `/api/export/csv` | CSV export |
| GET | `/api/export/pdf` | PDF export |
| GET | `/api/backup/download` | Admin-only SQL backup |
| POST | `/api/backup/restore` | Admin-only SQL restore |
| POST | `/api/sync/` | Admin-only full sync |
| POST | `/api/sync/prices` | Admin-only price sync |
| POST | `/api/sync/reschedule-full` | Reschedule full sync |
| POST | `/api/sync/reschedule-prices` | Reschedule price sync |
| GET | `/api/sync/status` | Sync status and history |
| GET | `/api/settings/` | Effective settings for current user |
| PUT | `/api/settings/` | Update settings |
| GET | `/api/settings/telegram_status` | Whether Telegram is configured for current user |
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
- Unique constraint in the ORM is `card_id + variant + lang`

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
  - `trainer_name`
- `ADMIN_ONLY_KEYS`
  - `full_sync_interval_days`
  - `price_sync_interval_minutes`
  - `multi_user_mode`

Important behavior:

- Each user only reads and writes their own `UserSetting` rows
- Admin-only settings are stored globally in `settings`
- Admin users can receive initial fallback values from env vars for Telegram and Gemini
- `recognize.py` intentionally reads Gemini only from the current user's `UserSetting`; there is no cross-user fallback

## Sync & Backup Behavior

### Sync

- `/api/sync/` and `/api/sync/prices` enforce admin access
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

## Scanner Notes

`backend/api/recognize.py` implements a two-step flow:

1. Gemini extracts card metadata from the uploaded photo
2. TCGdex candidate results are ranked by recognized card number
3. If the number is not decisive, Gemini visually compares the top candidates and picks the best match

Additional matching behavior:

- Name suffixes like `EX`, `GX`, `V`, `VMAX`, `VSTAR`, `TAG TEAM`, `BREAK`, and `LV.X` are stripped before search
- Search may fall back from detected card language to English
- Result payload includes recognized metadata and candidate matches

## Notifications

`backend/services/telegram.py` now accepts `user_id` and reads Telegram credentials from that user's `UserSetting` rows first.

## Migrations

- Migrations are raw SQL statements in `backend/database.py`
- They are idempotent and run on startup
- Legacy migration comments still mention older columns like `grade` or removed integrations, but the current runtime model and routers do not include eBay functionality
