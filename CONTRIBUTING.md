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

The frontend test command also validates literal translation keys. Add new user-facing keys to `src/i18n/en.js`; other language bundles can fall back to English until a translation is contributed. Missing keys fail with the source file and line instead of appearing as raw labels in the app.

## Card interfaces

The public card system in `src/components/card-system` is the normal starting point for card interfaces. It provides established frames, rows, badges, dialogs, and loading/error states so contributors can focus on the feature itself.

```jsx
import { CardDisplay, CardLegend, CardRow, CardStack } from '../components/card-system'

<CardDisplay variant="grid" card={card} image={image} />
<CardRow card={card} name={card.name} image={image} />
<CardLegend />
<CardStack card={card} image={image} layers={2} />
```

This keeps new features visually consistent without asking contributors to memorize every design detail. The available components and variants are documented in [`docs/CARD_SYSTEM.md`](docs/CARD_SYSTEM.md).

New visual ideas are encouraged. If an existing variant does not fit the feature, explain the difference and consider whether the idea should become a reusable shared variant:

1. Describe why the existing variants do not fit.
2. Add the behavior to the public card-system module.
3. Add the new state or variant to the component gallery.
4. Update its tests and documentation.

That process gives contributors room to evolve the design while helping accepted improvements remain consistent across features. The guide is reviewed by maintainers; there is no automated rule rejecting an alternative implementation merely because it is new.

## Pull requests

Keep pull requests focused and explain the reason for the change. Include desktop and mobile screenshots for visual work when practical. Reviewers use [`docs/CARD_SYSTEM.md`](docs/CARD_SYSTEM.md) as a consistency checklist and may suggest adapting a contribution to the shared visual language before merge.

Be kind, clear, and assume good intent during review.
