# Backend Reference

FastAPI application. Entry point: `backend/main.py`.

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sets/` | List all sets (optional `?lang=de\|en\|all&refresh=true`) |
| GET | `/api/sets/{set_id}` | Single set by composite key (e.g. `sv1_de`) |
| GET | `/api/sets/{set_id}/checklist` | All cards in a set with ownership status |
| GET | `/api/cards/search` | Search cards (`name`, `set_id`, `type`, `rarity`, `lang`, `page`, `page_size`) |
| GET | `/api/cards/{card_id}` | Single card detail |
| POST | `/api/cards/custom` | Create a manual card |
| PUT | `/api/cards/custom/{id}` | Update a manual card |
| GET | `/api/collection/` | All owned cards |
| POST | `/api/collection/` | Add card to collection |
| PUT | `/api/collection/{id}` | Update collection item |
| DELETE | `/api/collection/{id}` | Remove from collection |
| GET | `/api/dashboard/` | Portfolio summary (value, P&L, top cards, recent additions) |
| GET | `/api/analytics/duplicates` | Cards owned more than once |
| GET | `/api/analytics/top-movers` | Biggest price changes |
| GET | `/api/analytics/rarity-stats` | Collection breakdown by rarity |
| GET | `/api/analytics/investment-tracker` | Daily portfolio value history |
| GET | `/api/wishlist/` | Wishlist items |
| POST | `/api/wishlist/` | Add to wishlist |
| GET | `/api/binders/` | All binders |
| POST | `/api/binders/` | Create binder |
| GET | `/api/binders/{id}/cards` | Cards in a binder |
| POST | `/api/sync/` | Trigger full sync |
| POST | `/api/sync/prices` | Trigger price-only sync |
| GET | `/api/sync/status` | Is a sync currently running? |
| GET | `/api/settings/` | All settings |
| PUT | `/api/settings/` | Update settings |
| GET | `/api/export/csv` | Download collection as CSV |
| GET | `/api/export/pdf` | Download collection as PDF |
| GET | `/api/backup/download` | pg_dump SQL backup |
| POST | `/api/backup/restore` | Restore from SQL file |
| POST | `/api/recognize/` | AI card recognition from image (requires Gemini API key) |

## Models (SQLAlchemy)

### `Card`
Stores TCGdex card data. Key fields:
- `id` — composite: `{tcg_id}_{lang}` e.g. `sv1-1_de`
- `tcg_card_id` — original TCGdex ID e.g. `sv1-1`
- `set_id` — original TCGdex **set** ID e.g. `sv1` (NOT composite)
- `lang` — `en` or `de`
- `is_custom` — True for manually created cards
- Price fields: `price_market`, `price_low`, `price_trend`, `price_avg1`, `price_avg7`, `price_avg30`, plus holo and TCGPlayer variants

### `Set`
- `id` — composite: `{tcg_id}_{lang}` e.g. `sv1_de`
- `tcg_set_id` — original TCGdex ID e.g. `sv1`
- `lang` — `en` or `de`

### `CollectionItem`
- `card_id` → FK to `Card.id`
- `quantity`, `condition`, `variant`, `lang`, `purchase_price`

### `PriceHistory`
- Daily price snapshot per card: `card_id`, `date`, `price_market`, `price_trend`, etc.

### `PortfolioSnapshot`
- Daily portfolio total: `date`, `total_value`, `total_cost`

## TCGdex API Integration (`services/pokemon_api.py`)
- `get_all_sets(display_lang)` — fetches all sets in a given language
- `get_set_cards(set_id, lang)` — fetches cards for a set
- `get_card(card_id, lang)` — fetches a single card with full pricing
- `parse_card_for_db(card_data, ...)` — normalises TCGdex response into DB-ready dict
- `extract_prices(card_data)` — pulls all Cardmarket + TCGPlayer price fields

## Important Quirks
1. `cards.set_id` stores the **original** TCGdex set ID (`sv1`), not the composite DB set key (`sv1_de`). Joins must use `sets.tcg_set_id` when matching.
2. Card composite IDs use underscore suffix: `sv1-1_de`. Original TCGdex IDs use hyphens: `sv1-1`.
3. All migrations are idempotent SQL in `database._run_migrations()` — no Alembic.
4. The scheduler (`services/scheduler.py`) uses APScheduler and is started in `main.py` on startup.
