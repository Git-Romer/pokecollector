# Architecture Overview

> This document is intended to give AI assistants and new developers a complete understanding of the Pokemon TCG Collection Manager codebase without needing to read every file.

## Stack

| Layer | Technology | Port |
|-------|-----------|------|
| Frontend | React 18 + Vite + Tailwind CSS | 3000 |
| Backend | Python FastAPI | 8000 |
| Database | PostgreSQL 15 | 5432 |
| Card API | TCGdex (free, no key needed) | external |
| Containerisation | Docker + docker-compose | — |

## Directory Structure

```
pokecollector/
├── backend/                  # FastAPI application
│   ├── main.py               # App entry point, CORS, router registration
│   ├── models.py             # SQLAlchemy ORM models
│   ├── schemas.py            # Pydantic request/response schemas
│   ├── database.py           # DB engine, session, migrations, settings helpers
│   ├── api/                  # Route handlers (one file per feature)
│   │   ├── sets.py           # /sets — list, refresh, checklist
│   │   ├── cards.py          # /cards — search, custom cards, price history
│   │   ├── collection.py     # /collection — CRUD for owned cards
│   │   ├── analytics.py      # /analytics — duplicates, top movers, rarity stats
│   │   ├── dashboard.py      # /dashboard — portfolio summary
│   │   ├── binders.py        # /binders — virtual binders
│   │   ├── wishlist.py       # /wishlist — wishlist + price alerts
│   │   ├── sync.py           # /sync — manual/scheduled sync triggers
│   │   ├── settings.py       # /settings — app configuration
│   │   ├── export.py         # /export — CSV / PDF
│   │   ├── backup.py         # /backup — pg_dump / restore
│   │   ├── products.py       # /products — sealed product P&L
│   │   ├── recognize.py      # /recognize — AI card recognition (Gemini)
│   └── services/
│       ├── pokemon_api.py    # TCGdex API client + data parsing
│       ├── sync_service.py   # Full sync + price sync logic
│       ├── scheduler.py      # APScheduler background jobs
│       └── notifications.py  # Telegram price alert notifications
├── frontend/                 # React SPA
│   ├── src/
│   │   ├── pages/            # Top-level route pages
│   │   ├── components/       # Reusable UI components
│   │   ├── contexts/         # React contexts (Settings, etc.)
│   │   ├── api/client.js     # Axios API client — all backend calls
│   │   └── i18n/             # DE + EN translations
│   └── tailwind.config.js
├── docker-compose.yml
└── README.md
```

## Data Flow

### Card Search
1. User types in `CardSearch.jsx` → debounced query hits `GET /api/cards/search`
2. Backend queries local PostgreSQL `cards` table (no live API call)
3. Cards are cached during sync — not fetched on-demand from TCGdex
4. Language filter (`lang=de|en|all`) filters by `cards.lang` column

### Sync Process (`services/sync_service.py`)
1. `perform_sync()` — fetches all sets from TCGdex in both DE and EN, upserts into `sets` table
2. For each set, fetches all cards and upserts into `cards` table
3. `perform_price_sync()` — re-fetches pricing data for all cards in the collection, saves `PriceHistory` rows, takes a `PortfolioSnapshot`
4. APScheduler runs price sync every 30 min (configurable), full sync every 5 days

### Language / ID Model
- Sets are stored with **composite primary keys**: `sv1_de`, `sv1_en` (one row per language)
- `sets.tcg_set_id` stores the original TCGdex ID (`sv1`)
- Cards use composite IDs too: `sv1-1_de`, `sv1-1_en`
- `cards.tcg_card_id` stores the original TCGdex ID (`sv1-1`)
- `cards.set_id` stores the original TCGdex **set** ID (`sv1`) — NOT the composite set key

### Price Fields (Cardmarket EUR)
| Field | Description |
|-------|-------------|
| `price_market` | Average price (non-holo) |
| `price_low` | Low price |
| `price_trend` | 7-day trend price |
| `price_avg1` | 1-day average |
| `price_avg7` | 7-day average |
| `price_avg30` | 30-day average |
| `price_market_holo` | Average price (holo variant) |
| `price_trend_holo` | Trend price (holo) |
| `price_tcg_normal_market` | TCGPlayer normal market price (USD) |
| `price_tcg_reverse_market` | TCGPlayer reverse holo market (USD) |
| `price_tcg_holo_market` | TCGPlayer holo market (USD) |

The **primary price** used for portfolio value calculation is set in Settings → "Primary Price" (`settings.price_primary`, default: `trend`).

## Settings System
Settings are stored in a `settings` table as key-value pairs. The frontend reads them via `GET /api/settings/` on startup and caches them in `SettingsContext`. Key settings:

| Key | Default | Description |
|-----|---------|-------------|
| `language` | `de` | Display language (de/en) |
| `price_primary` | `trend` | Which price field drives portfolio value |
| `price_display` | `["trend","avg1","avg7","avg30","low"]` | Which price columns to show |
| `currency` | `EUR` | Display currency (EUR/USD, USD uses live exchange rate) |
| `full_sync_interval_days` | `5` | How often to re-fetch all sets+cards |

## Database Migrations
Migrations are **not Alembic** — they are raw SQL statements in `database.py → _run_migrations()`. Each migration uses `IF NOT EXISTS` / `DO $$ ... END$$` guards so they are idempotent and safe to run on every startup. New migrations should be appended at the end of the list with a version comment (e.g. `# v41: ...`).

## Frontend State Management
- **Server state**: TanStack Query (react-query) — all API data
- **UI state**: local `useState` per component
- **Global app config**: `SettingsContext` (language, price preferences, currency)
- **Routing**: React Router v6

## Key Components
| Component | File | Purpose |
|-----------|------|---------|
| `CardItem` | `components/CardItem.jsx` | Card grid tile + add-to-collection modal |
| `CardModal` | `components/CardItem.jsx` | Full card detail popup with prices |
| `SettingsContext` | `contexts/SettingsContext.jsx` | Global settings, `formatPrice()`, `t()` i18n |
| `PeriodSelector` | `components/PeriodSelector.jsx` | Price period tabs (trend/avg1/avg7/avg30) |
