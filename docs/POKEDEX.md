# National Pokédex view

PokéCollector includes a National Pokédex in addition to its set-first
catalogue. It can preserve traditional species-level completion or track
supported Mega and regional forms independently.

## Completion model

**Grouped species** is the default and remains compatible with the original
completion model. A species is **Owned** when the current user has at least one
collection item whose card contains that number in `cards.dex_ids`.

**Separate forms** derives exact entries in `cards.pokedex_entry_ids`. Base,
Mega, Alolan, Galarian, Hisuian, and Paldean entries are completed
independently. For example, `6:mega-x` is displayed as `#006-MX`; owning only
that card does not complete base Charizard in this mode. A mixed card such as
Raichu & Alolan Raichu can complete both `26` and `26:alola`.

Only form entries with at least one physical printing in the locally visible
catalogue participate in totals. A game form without a synced card therefore
cannot make the Pokédex impossible to complete.

A multi-Pokémon card can contain several mappings and counts toward every
species or form it genuinely depicts. Removing the final matching collection
item changes that entry back to **Missing**.

Condition, physical variant, printing-detail tags, purchase price, Binder/Deck
allocation, and owner-card photos do not change completion: one positive
collection quantity for a matching entry is sufficient.

## Data sources

- The bundled `backend/data/pokedex.json` contains National Dex #001–1025, English and German names, generation, region, and types.
- Full TCGdex card enrichment stores `dexId` as `cards.dex_ids`.
- Because TCGdex does not expose a reliable form field, PokéCollector derives
  `cards.pokedex_entry_ids` using a versioned, curated form catalogue and
  multilingual name rules. Stable TCGdex card-ID overrides resolve legacy
  M-Charizard and M-Mewtwo printings whose names do not identify X or Y.
- The initial exact-form scope is Base, Mega, Alolan, Galarian, Hisuian, and
  Paldean. Gigantamax and other ambiguous transformations remain grouped until
  a reliable classification rule is added.
- If TCGdex omits `dexId` for a full Pokémon card, PokéCollector conservatively infers the National Dex number from an exact English or German base species name, such as `Mega-Glurak Y-ex` -> `Glurak` -> `006`.
- TCGdex variant-level Cardmarket catalogue IDs are stored in `cards.cardmarket_products` without collapsing foil variants.

Existing set-list rows only contain brief card data. After upgrading, the
backend starts a versioned background backfill and records completion in the
`pokedex_metadata_backfill_completed` setting. Exact form mappings are derived
locally from existing card rows; missing upstream metadata is enriched through
the existing TCGdex path. Collection rows are never rewritten. To retry or
inspect the backfill manually:

```bash
docker compose exec backend \
  python -m scripts.backfill_pokedex_metadata --limit 5000
```

Repeat the manual command until `attempted` becomes `0`, or use `--refresh` to refetch selected catalogue rows.

## Image cache

Pokédex tiles use a pixel sprite first. Detail headers use official artwork
first. Form routes resolve to form-specific PokeAPI image IDs before using the
same persistent cache:

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
/pokedex/{entry_id}
```

API:

```text
GET /api/pokedex
GET /api/pokedex/{entry_id}
GET /api/pokedex/images/sprites/{entry_id}.png
GET /api/pokedex/images/artwork/{entry_id}.png
GET /api/cards/search?dex_id={dex_id}
GET /api/cards/search?pokedex_entry_id={entry_id}
```

Numeric `entry_id` values preserve the original routes. Form entries use keys
such as `6:mega-x`. The overview supports `generation`, `region`, `status`,
`search`, `lang`, `mode=grouped|forms`, and
`form_family=all|base|mega|alola|galar|hisui|paldea`. Frontend mode,
generation, and form filters are stored in the URL so refresh, Back/Forward,
and list scroll restoration remain consistent.

The detail page shows related forms and can sort exact matching printings by the user's selected primary price in
either direction, owned first, Wishlist first, or set/card number. Card actions
reuse the normal shared card dialog and collection/Wishlist workflows.

## Cardmarket links

Specific card views prefer an exact public Cardmarket product redirect stored in `cardmarket_products`:

```text
https://www.cardmarket.com/en/Pokemon/Products?idProduct={product_id}
```

When no exact product ID is available, PokéCollector opens a Pokémon-category Cardmarket search built from the card name, set abbreviation, and collector number.

## Wishlist export follow-up

The current schema intentionally exposes the metadata needed for a later “Export wishlist for Cardmarket” transfer assistant. Automated Cardmarket account login, wants-list synchronization, cart creation, and Shopping Wizard execution are not part of this change.

The original delivered scope and boundaries are preserved in the
[`POKEDEX_IMPLEMENTATION_BRIEF.md`](POKEDEX_IMPLEMENTATION_BRIEF.md) historical
brief. This document is the current operational reference.
