# John John's PC Final Refinement

## Global Constraints

- Product name is "John John's PC".
- Primary navigation labels remain exactly: Collection, Card Search, All Cards, Trends & Insights, Settings.
- Collection page heading remains "My Collection".
- Motion is part of the design system and has no in-app reduced-motion toggle.
- Spectrum colors are identity/vibe colors, not functional status colors.
- Card Search is the discovery surface for the full Pokemon card catalog and must keep Owned Only and Add to Collection behavior.
- Trends & Insights portfolio scope is Vault, PC, and only the top 5-10% by market value in Main Collection.
- Missing purchase price/cost basis must use the label "Cost Basis Needed" and must be excluded from profit/loss.
- Preserve existing API routes and database data.

## Task 1 - Refine Card Search discovery experience

Add the settled "Card Search (Fluent: Discovery & Motion)" experience definition to the Card Search surface without turning it into a marketing page.

Requirements:

- Keep the page usable as the full catalog search first.
- Keep the Owned Only toggle.
- Keep the clear Add to Collection action in card detail.
- Make the Discovery rail visibly use these exact module labels: New Set Drops, Meta & Deckbuilding, Trending Cards.
- Do not restore Featured Expansions.
- Do not reference Pokemon.com.
- Source live discovery modules from Pokebeach only in the current implementation.
- Use concise collector-facing copy:
  - identifying cards
  - adding lots
  - exploring sets
  - browsing inspiration signals
- Motion should communicate discovery and activity through existing transitions/hover behavior, not decorative continuous animation.

## Task 2 - Refine Trends & Insights portfolio scope

Make the Portfolio Performance tab explicit and internally consistent with the settled investment model.

Requirements:

- Scope must be visibly described as Vault, PC, and the highest-value 10% of Main Collection.
- Show that sealed product can be included when it is marked Vault or PC.
- Keep missing cost basis label exactly "Cost Basis Needed".
- Show card and sealed-product counts separately when both exist.
- Keep cards without cost basis in market value totals, but exclude them from profit/loss.
- Avoid adding financial context to the Collection page.
- Do not change the backend portfolio summary math unless the existing response prevents the UI from expressing the required scope.
