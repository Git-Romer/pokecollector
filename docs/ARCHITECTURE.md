# Architecture Overview

This document reflects the current code layout at the repository root.

## Stack

| Layer | Technology | Port |
|-------|-----------|------|
| Frontend | React 18 + Vite + Tailwind CSS | 3000 |
| Backend | FastAPI | 8000 |
| Database | PostgreSQL 18 | 5432 |
| External APIs | TCGdex, Gemini, Frankfurter, GitHub | external |
| Containerization | Docker + docker compose | - |

## Directory Structure

```text
pokecollector/
├── backend/
│   ├── main.py
│   ├── database.py
│   ├── models.py
│   ├── schemas.py
│   ├── api/
│   │   ├── auth.py
│   │   ├── backup.py
│   │   ├── binders.py
│   │   ├── cards.py
│   │   ├── collection.py
│   │   ├── dashboard.py
│   │   ├── export.py
│   │   ├── github.py
│   │   ├── images.py
│   │   ├── products.py
│   │   ├── recognize.py
│   │   ├── settings.py
│   │   ├── sets.py
│   │   ├── social.py
│   │   ├── sync.py
│   │   └── wishlist.py
│   └── services/
│       ├── auth.py
│       ├── card_fallbacks.py
│       ├── pokemon_api.py
│       ├── pre_upgrade_backup.py
│       ├── scheduler.py
│       ├── sync_service.py
│       ├── tcgdex_languages.py
│       └── telegram.py
├── frontend/
│   ├── src/
│   │   ├── api/client.js
│   │   ├── components/
│   │   │   ├── AppNav.jsx
│   │   │   ├── CardItem.jsx
│   │   │   ├── CardScanner.jsx
│   │   │   ├── Layout.jsx
│   │   │   └── TabNav.jsx
│   │   ├── contexts/
│   │   │   ├── AuthContext.jsx
│   │   │   └── SettingsContext.jsx
│   │   ├── hooks/
│   │   │   └── useTheme.js
│   │   ├── i18n/        # App translation bundles
│   │   ├── utils/       # Shared frontend helpers, including language registries
│   │   └── pages/
│   └── index.html
├── docs/
├── SUPPORTERS.csv
├── docker-compose.yml
└── README.md
```

Removed from the current architecture:

- no `backend/api/ebay.py`
- no `services/notifications.py`
- no old nested `pokemon-tcg-collection/` directory

## Backend Architecture

### Router Registration

`backend/main.py` registers feature routers under `/api/*`.

Important modules added since the older docs:

- `api/auth.py`
- `api/github.py`
- `api/images.py`
- `api/products.py`

### Data Model

Key ORM models in `backend/models.py`:

- `Set`
- `Card`
- `User`
- `CollectionItem`
- `WishlistItem`
- `Binder`
- `BinderCard`
- `ProductPurchase`
- `SyncLog`
- `PortfolioSnapshot`
- `Setting`
- `UserSetting`
- `CustomCardMatch`
- `ImageCache`

Notable current model rules:

- `Set.id` and `Card.id` are composite ids with TCGdex language suffixes, including multi-part codes such as `zh-tw` and `pt-br`
- `Card.rarity` comes from TCGdex and is treated as read-only metadata
- Card data, image, and price fallback source languages are tagged when English exact-ID fallback data is used
- Collection variants are limited to physical print variants
- Wishlist items store requested quantity from `1` to `99`
- `User.must_change_password` drives the forced password change flow
- `UserSetting` stores per-user preferences and secrets

## Settings Architecture

Settings are split between two stores:

- Global `settings` table
- Per-user `user_settings` table

The split is defined in `backend/api/settings.py`:

- `PER_USER_KEYS`
  - language
  - currency
  - price display preferences
  - Telegram keys and alert preferences
  - Gemini key
  - trainer name
- `ADMIN_ONLY_KEYS`
  - full sync interval
  - price sync interval
  - multi-user mode
  - TCGdex sync languages

Effectively:

- normal users can only change their own per-user settings
- admins can also change global operational settings
- per-user settings isolation is enforced in the API layer
- `tcgdex_sync_languages` controls which TCGdex set/card languages full sync fetches. It defaults to `en,de`; extra languages are optional because they increase sync time, API calls, and database size.
- Invalid or empty `TCGDEX_SYNC_LANGUAGES` env values fall back safely to `en,de` during first bootstrap; the env value `all` expands to every supported TCGdex language
- App UI language selection is separate from TCGdex sync-language selection. The UI selector includes all supported TCGdex language codes plus Swedish.

## Authentication Architecture

Authentication lives in:

- `backend/api/auth.py`
- `backend/services/auth.py`
- `frontend/src/contexts/AuthContext.jsx`

Current auth model:

- Single-user mode returns the admin user from `get_current_user()` when no token is present
- Multi-user mode requires JWT authentication
- `/api/auth/mode` exposes whether the app is in single-user or multi-user mode
- `must_change_password` is returned by `/api/auth/login` and `/api/auth/me`
- The frontend blocks protected routes until forced password change is completed

## Scanner Flow

Recognition is implemented in `backend/api/recognize.py` and surfaced in `frontend/src/components/CardScanner.jsx`.

Current flow:

1. User uploads or captures a card image
2. Gemini extracts card name, English name, printed number, set hint, type, HP, and language
3. Search terms are broadened by stripping suffixes such as `EX`, `GX`, `V`, `VMAX`, `VSTAR`, `TAG TEAM`, `BREAK`, and `LV.X`
4. TCGdex search results are collected in the detected language, with English fallback when needed
5. Results are ranked by printed card number
6. If number ranking is not decisive and there are enough candidates, Gemini visually compares the top candidates and picks the best match

Transient Gemini `502` / `503` / `504` capacity errors are retried with backoff. Gemini `429` responses are surfaced as rate-limit errors, invalid API keys get a dedicated message, and remaining temporary Gemini outages return a clearer temporary-unavailable response instead of a generic backend `500`.

The frontend then lets the user choose quantity, condition, variant, language, and purchase price before adding to the collection. Search results can also be selected in bulk and added with default values in one request.

## Frontend State

Current frontend state layers:

- Server state: TanStack Query
- Auth state: `AuthContext`
- Settings and i18n state: `SettingsContext`
- Local UI state: component-level `useState`
- Theme state: `useTheme` with `data-theme` and local storage

`AuthContext` is now a core part of the app architecture, not an optional enhancement.

## Navigation Architecture

- `HomeScreen.jsx` is the compact portal entry point
- `Layout.jsx` wraps protected routes
- `AppNav.jsx` provides the page title strip and logout affordance
- `TabNav.jsx` is the shared section tab component used across major screens

## Integrations

### TCGdex

- Set and card source of truth
- Variant availability flags come from TCGdex
- Rarity is read from TCGdex and shown read-only
- Supported sync languages are centralized in `backend/services/tcgdex_languages.py`
- English is the preferred fallback for missing data, images, and prices only when the same exact TCGdex card or set ID exists in English
- Regional-only cards are not guessed by translated name

### Gemini

- Used for smart scanner recognition
- Key is read per user from `user_settings`
- Scanner calls use the API-key header rather than putting the key in the request URL
- Transient capacity failures are retried; rate limits and invalid keys are reported separately

### Telegram

- Implemented in `backend/services/telegram.py`
- Service accepts `user_id` so alerts use that user's Telegram credentials

### GitHub / Community

- `backend/api/github.py` fetches contributors from the GitHub API
- Supporters are read from `SUPPORTERS.csv`
- `frontend/src/pages/Settings.jsx` renders both in the Community section

## Security Notes

- Sync endpoints are admin-only
- Backup and restore are admin-only
- Settings keys are separated into admin-only and per-user scopes
- Frontend logout clears local storage and forces a full reload to avoid leaking cached user data across sessions
- User deletion explicitly removes owned rows from collection, wishlist, binders, products, portfolio snapshots, and user settings before deleting the user

## Migration Notes

Schema changes are handled by idempotent SQL in `backend/database.py`, not Alembic.

Some migration comments still mention historical features, but the current runtime architecture does not include eBay integration and does not expose grading in the active UI or ORM model.
