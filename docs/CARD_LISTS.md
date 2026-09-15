# Card Lists and Decks

PokéCollector uses one Card List system for collection organization and deck
building. Binders, Planned Binders, Planned Decks, and Real Decks share the
`binders` and `binder_cards` tables and the same frontend building blocks.

## List types

| UI type | `binder_type` | Purpose | Uses owned-copy allocation? |
| --- | --- | --- | --- |
| Binder | `collection` | Physical cards placed in a binder or other location | Yes |
| Planned Binder | `wishlist` | A future collection project that may include missing cards | No |
| Planned Deck | `deck` | A deck list that may exceed current ownership | No |
| Real Deck | `physical_deck` | A built deck containing exact owned copies | Yes |

Planned rows reference the localized catalogue `Card.id` and store a required
quantity. A physical Binder represents each allocation with a row linked to the
exact `CollectionItem`; a Real Deck keeps its requirement rows and stores exact
allocations as additional linked rows. Quantity totals and unique-card totals
are reported separately.

## Shared allocation rules

Physical Binders and Real Decks draw from the same inventory capacity. One
owned copy cannot be assigned to multiple physical lists. Allocation checks are
user-scoped, row-locked, and performed in a consistent order so concurrent
requests cannot over-allocate the same collection row.

Planned Binders and Planned Decks do not reserve cards. Their shortages compare
required quantities with owned quantities and copies already reserved in other
physical lists.

Deleting a physical list or converting a Real Deck back to a Planned Deck
releases its allocations; it does not delete cards from the collection.

## Binder workflows

Binders support:

- adding exact owned collection rows;
- Planned Binder catalogue entries and requested quantities;
- switching an entry to an equivalent printing;
- previewing and applying equivalent-print optimization;
- sending one entry or all missing entries to the global Wishlist;
- converting a Planned Binder into a physical Binder when the required copies
  are available;
- converting a physical Binder back into a Planned Binder and releasing its
  exact-copy allocations;
- creating or populating a physical Binder from every available owned card in
  a set; and
- CSV import/export.

A collection Binder or Deck may be shared publicly only when the administrator
enables public profiles, its owner publishes a public profile, and that
individual list has `is_public=true`. Existing Decks and every newly created
list are private by default. A Deck containing a private custom card cannot be
shared, and a private custom card cannot be added while the Deck is public.

The global Wishlist has a separate profile-wide visibility setting:

- **Private** (default) never shares Wishlist data.
- **Trade matches** lets authenticated comparisons use only relevant matches;
  it never returns the complete Wishlist.
- **Public wishlist** exposes a paginated, searchable and filterable catalogue
  projection at `/u/:handle/wishlist`.

Public Wishlist responses contain card identity, artwork, set, number, rarity,
language, requested quantity, and date added. Alert thresholds, notification
history, internal row IDs, owner photos, and private custom cards are excluded.
Market values and price sorting follow the profile's separate public-values
preference.

## Deck workflows

Decks use target sizes of 20, 40, or 60 cards (60 by default) and formats
`Standard`, `Expanded`, `Unlimited`, or `Casual` (`Casual` by default).

The editor provides:

- catalogue search and quantity editing;
- owned, available, reserved, and shortage counts per entry;
- composition totals for Pokémon, Trainer, Energy, and other cards;
- deck-size validation, at least one Basic Pokémon, and the four-copy limit by
  card name (Basic Energy is exempt);
- Standard legality checks using regulation/printing equivalence metadata;
  Expanded and Unlimited legality are reported as unavailable rather than
  guessed;
- opening-hand/draw/prize probability calculations;
- duplicate-as-new-plan behavior; and
- side-by-side deck comparison.

A Planned Deck converts atomically to a Real Deck only if every required copy
is owned and unassigned. The conversion reserves exact collection rows. A
duplicate is always a new Planned Deck; the source Real Deck keeps its physical
allocations.

The `/decks` and `/decks/inventory` frontend paths redirect to `/binders`, where
all lists are managed. `/decks/:deckId` opens the Deck editor and
`/decks/compare` opens comparison. The `/api/decks` compatibility API provides
Deck-specific CRUD, conversion, validation, allocation, comparison, and
probability responses.

Shared Planned and Real Decks appear under `/u/:handle/decks`; their details are
available at `/u/:handle/deck/:deckId`. The public projection reuses Deck
composition, rules validation, analytics, and probability calculations, but
omits collection ownership, shortages, exact allocations, conditions, purchase
prices, and collection-row IDs.

## Printing identity and details

A list entry points to a specific localized printing, not just a translated
card name. Equivalent-print tools deliberately control when another printing
may be substituted.

Reusable printing-detail tags are owner-scoped labels for properties not
represented by the fixed variant field, such as signed, stamped, altered, or a
known misprint. The same tag records can be attached to collection copies,
product-card history, product ledger entries, and trade items so those physical
details survive lifecycle changes.
