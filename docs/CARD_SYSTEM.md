# Card System

PokéCollector exposes a public card-interface module at `frontend/src/components/card-system`. It is the normal starting point for card features because it already carries the established visual structure, responsive behavior, borders, state indicators, image fallbacks, and interaction states.

This guide is a shared reference for contributors, maintainers, and AI-assisted reviews. It helps new work fit the application without requiring anyone to memorize old screenshots. It is not a ban on new ideas: a genuinely new interaction or presentation can evolve the system after review.

## Public API

Import from the directory entry point:

```jsx
import {
  CardDialog,
  CardDisplay,
  CardIdentity,
  CardLegend,
  CardRow,
  CardStack,
} from '../components/card-system'
```

| Component | Use |
| --- | --- |
| `CardDisplay` | Full cards and artwork presentations |
| `CardRow` | Compact list and table rows |
| `CardIdentity` | Compact artwork, name, number, and metadata inside a larger row |
| `CardDialog` | Shared card-detail dialog frame |
| `CardLegend` | Collapsible or always-visible explanation of card badges and borders |
| `CardStack` | Layered presentation for grouped prints, with shared artwork behavior |

`CardDisplay` supports these variants:

| Variant | Intended context |
| --- | --- |
| `grid` | Standard collection, set, Pokédex, binder, and search grids |
| `carousel` | Compact horizontal card groups |
| `ranking` | Ranked and valuable-card presentations |
| `selectable` | Bulk selection and picker workflows |
| `artwork` | Complete artwork inside the shared border, without a caption |
| `compact-artwork` | Small list/table thumbnail |
| `comparison` | Responsive artwork used in migration/comparison rows |

The components accept the existing card data and action props. They automatically provide the shared visual states when given values such as `selected`, `dimWhenUnowned`, `unavailableReason`, `onClick`, or `onSelect`.

## Design tokens

Shared dimensions, radii, and border colors live in `card-system/tokens.css`; JavaScript consumers use `CARD_SYSTEM_TOKENS` from `tokens.js`. Adjust these tokens or a shared component when a design decision should change everywhere.

Pages remain responsible for their surrounding layout, grids, panels, filters, and feature-specific actions. Reusing the established card components is usually the cleanest option; when a feature needs something different, explain the reason so reviewers can decide whether it is a local interaction or a useful shared addition.

## Established visual language

Use these points when implementing or reviewing any screen that presents cards:

- Full cards use one frame. The default frame is grey; data, price, and image fallbacks use the shared purple, amber, and blue frame treatments. Manual artwork used because official artwork is missing belongs to the image-fallback treatment.
- Hover and keyboard focus brighten the frame with a restrained glow. Touch actions must remain available without hover.
- Ownership, print variation, quantity, wishlist, product-source, selection, and binder-progress indicators use the shared badges. Any screen that displays these indicators also provides the shared legend nearby.
- Missing cards in comparison contexts such as Set and Pokédex views keep the grey ownership overlay. Disabled cards show a reason instead of silently ignoring interaction.
- Card names stay on one ellipsized line in aligned grids and compact rows. The set abbreviation/card number and price remain aligned when neighboring names have different lengths.
- Missing artwork uses the Pokémon card back. Loading uses the shared skeleton; failed supplied artwork offers retry; compact lists prioritize visible images and defer distant rows.
- Compact rows show the complete artwork inside the standard compact frame. Collection, Analytics, Wishlist, trades, comparisons, rankings, binders, and optimizer rows should feel like the same family.
- Dialogs use the shared floating, content-sized frame on desktop and mobile. The close action stays at the top-right and tabs/actions remain centered and usable with keyboard and touch.
- Specialist workflows may optimize speed and selection behavior, but scanner, binder, optimizer, trade, bulk-selection, and migration views keep the shared card identity and state language.

## Component gallery

In development, run:

```bash
cd frontend
npm run dev
```

Open `/__card-system` to see the supported variants, ownership states, fallbacks, unavailable cards, legends, rows, and dialogs together. The route is excluded from production builds.

## Adding a new idea

Do not force a genuinely different interaction into the wrong variant. A contributor can propose a new shared pattern or a clearly justified feature-specific presentation:

1. Describe the user need and why the closest existing pattern does not fit.
2. Decide during review whether the idea is feature-specific or belongs in the shared components.
3. Preserve keyboard, touch, loading, retry, unavailable, and responsive behavior.
4. Show the result on desktop and mobile.
5. If it becomes shared, add it to `CardSystemGallery.jsx`, tests, and this guide.

Review should focus on whether the idea belongs in the shared system and whether existing consumers remain stable, not on discouraging the proposal.

## Contributor checklist

- Identify the closest existing full-card, compact-row, ranking, selectable, comparison, stack, dialog, and legend patterns before starting.
- Use shared components where they fit; explain intentional differences in the pull request.
- Check real data combinations: owned/unowned, wishlist, multiple variants, quantities, mixed languages, all fallback-source combinations, manual artwork, missing artwork, and unavailable states.
- Check long and missing names, numbers, prices, rarity, and metadata without breaking alignment.
- Check loading, retry, cached remounts, large lists, keyboard, touch, and responsive behavior.
- Include desktop and mobile screenshots for affected screens and update shared visual snapshots when appropriate.
- Add English translation keys for new labels. Other locales may fall back to English until translated.

## Reviewer checklist

Maintainers and AI-assisted reviews should use this checklist for every pull request or issue that adds or changes card UI:

1. Compare the proposal with the closest established patterns and the visual language above.
2. Inspect every affected consumer, not only the screenshot or page named in the issue.
3. Confirm that card data comes from the correct object, especially collection-item variant, quantity, condition, language, wishlist, and product state.
4. Check that indicators have a legend and fallback frames still communicate data, price, image, and manual-artwork fallback states.
5. Exercise edge states and specialist workflows rather than reviewing only the default card.
6. Test representative real pages on desktop and mobile. Use Chromium and WebKit/Safari for browser-facing loading or layout changes.
7. If the design is genuinely new, help the contributor integrate it cleanly or promote it into a shared pattern instead of rejecting the idea.
8. Rework inconsistent details before merge and update this guide when the accepted visual language changes.

Automated unit, translation, build, and visual-regression tests remain useful safety nets. The visual suite covers the component gallery plus representative real Collection and Analytics pages on desktop and mobile, with a dedicated WebKit large-list check. Visual consistency is ultimately a review responsibility rather than a code-enforced import restriction.
