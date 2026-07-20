# Public binder — stacked variant tiles

## Goal

In the public binder view (`/u/:handle/binder/:id`), collapse a card's multiple
prints into a single tile and give it a physical "stack of cards" look whose depth
reflects how many distinct variants are owned.

## Scope

Frontend only. The public API (`GET /api/public/profiles/{handle}/binders/{id}`)
already returns one entry per (card, variant) with `variant`, `quantity`, and
per-variant `market_value`, sorted by set → natural card number → variant. No
backend change.

## Behaviour

- **Group by card.** `binder.cards` (contiguous per card thanks to server sort) is
  grouped by `card.id` into one tile per card carrying an ordered list of prints
  `[{ variant, quantity, market_value }]`.
- **Tile content.** Card image, name, `set · #number`, a `VariantPills` row of every
  owned print with its ×quantity, and — only when the profile exposes values — the
  summed value across the card's prints.
- **Stack depth = distinct variants.** Back-layers rendered = `min(variants − 1, 2)`:
  1 variant → flat tile; 2 variants → 1 layer behind; 3+ → 2 layers (capped). A
  single-variant card stays flat even at quantity ×3 (depth follows distinct prints,
  not copies).
- **Stack look.** Each back-layer is the same rounded card silhouette, offset a few px
  down-right and rotated ~2°, in the card border colour, sitting behind the image.

## Components

- `groupCardsByPrint(cards)` — pure util (`frontend/src/utils/`). Input: the flat
  `cards` array. Output: ordered array of `{ id, name, image, set_name, number,
  prints: [{variant, quantity, market_value}], variantCount, total_value }` where
  `total_value` is `null` if every print's `market_value` is null (values hidden),
  else the summed `market_value × quantity`. First-seen order preserved.
- `PublicBinderView.jsx` — maps grouped tiles; renders the stack layers + `VariantPills`.

## Testing

- Vitest unit tests for `groupCardsByPrint`: grouping/merge, order preservation,
  variantCount, value summing, and null-value (hidden) case.
- Visual stack verified via `npm run build` + a look at the live page (this frontend
  has no DOM test infra).

## Out of scope

Owner-side binder views (unchanged). No new i18n beyond reuse of existing
`variants.*` keys via `VariantPills`.
