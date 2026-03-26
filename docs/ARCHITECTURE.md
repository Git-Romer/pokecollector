# Architecture Overview

This document reflects the current code layout under `/tmp/pokecollector`.

## Stack

| Layer | Technology | Port |
|-------|-----------|------|
| Frontend | React 18 + Vite + Tailwind CSS | 3000 |
| Backend | FastAPI | 8000 |
| Database | PostgreSQL 15 | 5432 |
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
│       ├── pokemon_api.py
│       ├── scheduler.py
│       ├── sync_service.py
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
│   │   ├── i18n/
│   │   │   ├── de.js
│   │   │   ├── en.js
│   │   │   └── zh.js
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

- `Set.id` and `Card.id` are composite ids with language suffixes
- `Card.rarity` comes from TCGdex and is treated as read-only metadata
- Collection variants are limited to physical print variants
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

Effectively:

- normal users can only change their own per-user settings
- admins can also change global operational settings
- per-user settings isolation is enforced in the API layer

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
6. If number ranking is not decisive, Gemini visually compares the top candidates and picks the best match

The frontend then lets the user choose quantity, condition, variant, language, and purchase price before adding to the collection.

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

### Gemini

- Used for smart scanner recognition
- Key is read per user from `user_settings`

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
