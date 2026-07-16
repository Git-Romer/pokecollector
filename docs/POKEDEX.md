# National Pokédex view

PokéCollector now includes a species-level National Pokédex in addition to its existing set-first catalogue.

## Completion model

A species is **Owned** when the current user has at least one collection item whose card has that National Pokédex number in `cards.dex_ids`. Completion is derived from the existing collection; there is no separate “mark complete” record.

A multi-Pokémon card can contain several `dex_ids` and counts toward each species. Removing the final matching collection item changes the species back to **Missing**.

## Data sources

- The bundled `backend/data/pokedex.json` contains National Dex #001–1025, English and German names, generation, region, and types.
- Full TCGdex card enrichment stores `dexId` as `cards.dex_ids`.
- If TCGdex omits `dexId` for a full Pokémon card, PokéCollector conservatively infers the National Dex number from an exact English or German base species name, such as `Mega-Glurak Y-ex` -> `Glurak` -> `006`.
- TCGdex variant-level Cardmarket catalogue IDs are stored in `cards.cardmarket_products` without collapsing foil variants.

Existing set-list rows only contain brief card data. After upgrading, the backend starts a one-time background backfill and records completion in the `pokedex_metadata_backfill_completed` setting. Parser revisions, such as improved missing-`dexId` inference, can advance the internal backfill revision so previously attempted empty mappings are retried once. To retry or inspect the backfill manually:

```bash
docker compose exec backend \
  python -m scripts.backfill_pokedex_metadata --limit 5000
```

Repeat the manual command until `attempted` becomes `0`, or use `--refresh` to refetch selected catalogue rows.

## Image cache

Pokédex tiles use a pixel sprite first. Species headers use official artwork first. Both are served from the persistent local cache:

```text
/app/data/pokedex-images/sprites/{dex_id}.png
/app/data/pokedex-images/artwork/{dex_id}.png
```

The Compose bind mount is:

```yaml
- ./data/pokedex-images:/app/data/pokedex-images
```

Images are cached lazily on first request. To populate the complete cache ahead of time:

```bash
docker compose exec backend \
  python -m scripts.cache_pokedex_images
```

Useful options:

```bash
python -m scripts.cache_pokedex_images --min 152 --max 386
python -m scripts.cache_pokedex_images --refresh
python -m scripts.cache_pokedex_images --delay 0.1
```

The fetcher writes temporary files and atomically renames them, continues after individual failures, and reports missing/failed entries at the end.

## Routes

Frontend:

```text
/pokedex
/pokedex/{dex_id}
```

API:

```text
GET /api/pokedex
GET /api/pokedex/{dex_id}
GET /api/pokedex/images/sprites/{dex_id}.png
GET /api/pokedex/images/artwork/{dex_id}.png
GET /api/cards/search?dex_id={dex_id}
```

The overview supports `generation`, `region`, `status`, `search`, and `lang` query parameters.

## Cardmarket links

Specific card views prefer an exact public Cardmarket product redirect stored in `cardmarket_products`:

```text
https://www.cardmarket.com/en/Pokemon/Products?idProduct={product_id}
```

When no exact product ID is available, PokéCollector opens a Pokémon-category Cardmarket search built from the card name, set abbreviation, and collector number.

## Wishlist export follow-up

The current schema intentionally exposes the metadata needed for a later “Export wishlist for Cardmarket” transfer assistant. Automated Cardmarket account login, wants-list synchronization, cart creation, and Shopping Wizard execution are not part of this change.
