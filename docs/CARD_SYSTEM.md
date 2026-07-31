# Card System

PokéCollector exposes one public card-interface module at `frontend/src/components/card-system`. Feature pages provide card data and actions; the system owns the visual structure, responsive behavior, borders, state indicators, image fallbacks, and interaction states.

This makes the approved design the easiest path for new features while leaving an explicit route for new ideas.

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

Feature styles must not recreate card-system frame classes. Page layout remains the feature's responsibility: grids, surrounding panels, filters, and feature-specific actions can still be designed normally.

## Component gallery

In development, run:

```bash
cd frontend
npm run dev
```

Open `/__card-system` to see the supported variants, ownership states, fallbacks, unavailable cards, legends, rows, and dialogs together. The route is excluded from production builds.

## Adding a new idea

Do not force a genuinely different interaction into the wrong variant. Instead:

1. Confirm that the difference is reusable rather than page-specific decoration.
2. Add or extend a public variant in `components/card-system`.
3. Preserve keyboard, touch, loading, retry, unavailable, and responsive behavior.
4. Add the example to `CardSystemGallery.jsx`.
5. Update unit and visual-regression tests.
6. Document the intended use here.

Review should focus on whether the idea belongs in the shared system and whether existing consumers remain stable—not on discouraging the proposal.

## Enforcement

`npm test` runs `npm run check:card-system`. It flags feature code that imports legacy internals, assembles low-level card components, or uses internal frame classes. The error points contributors to the shared extension workflow.

Visual screenshot tests cover the component gallery on desktop and mobile. A deliberate shared visual change should update the snapshots and include the resulting difference in review.
