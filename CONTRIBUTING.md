# Contributing to PokéCollector

Contributions of every size are welcome: bug fixes, new features, visual ideas, documentation, and tests.

## Development workflow

1. Fork the repository and create a focused branch.
2. Explain the user problem your change solves.
3. Add or update tests and documentation where appropriate.
4. Run the relevant checks before opening a pull request.

For frontend work:

```bash
cd frontend
npm ci
npm test
npm run build
```

## Card interfaces

Feature pages should use the public card system from `src/components/card-system` instead of building card frames, rows, badges, dialogs, or loading/error states themselves.

```jsx
import { CardDisplay, CardLegend, CardRow, CardStack } from '../components/card-system'

<CardDisplay variant="grid" card={card} image={image} />
<CardRow card={card} name={card.name} image={image} />
<CardLegend />
<CardStack card={card} image={image} layers={2} />
```

This keeps new features visually consistent without asking contributors to memorize every design detail. The available components and variants are documented in [`docs/CARD_SYSTEM.md`](docs/CARD_SYSTEM.md).

New visual ideas are encouraged. If an existing variant does not fit the feature, propose a new shared variant instead of creating a page-specific card:

1. Describe why the existing variants do not fit.
2. Add the behavior to the public card-system module.
3. Add the new state or variant to the component gallery.
4. Update its tests and documentation.

That process gives contributors room to evolve the design while ensuring that an accepted improvement becomes available to every feature.

## Pull requests

Keep pull requests focused and explain the reason for the change. Screenshots are useful for visual work. If a check rejects a card layout, it includes the shared extension path; it is an architecture prompt, not a ban on new designs.

Be kind, clear, and assume good intent during review.
