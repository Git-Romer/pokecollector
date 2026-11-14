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

For backend work, install `backend/requirements.txt` and run the relevant
standard-library `unittest` files (or the full suite) with the backend on the
Python import path:

```bash
python -m pip install -r backend/requirements.txt
(cd backend && python -m unittest discover -s tests -p 'test_*.py')
```

For changes that touch versions or deployment definitions, also run:

```bash
node scripts/check-version.mjs
docker compose config --quiet
docker compose -f docker-compose.yml -f docker-compose.build.yml config --quiet
```

Update the README or the focused guide under `docs/` whenever behavior,
configuration, routes, storage, privacy, or operational steps change. Keep
historical implementation briefs clearly labelled so they are not mistaken for
current instructions.

The frontend test command validates literal translation keys and all translation JSON files. Add new user-facing keys to `src/i18n/locales/en.json`; other language bundles can fall back to English until a translation is contributed. Missing keys fail with the source file and line instead of appearing as raw labels in the app. Duplicate keys, blank translations and placeholder mismatches are also rejected.

To build and run the container images from your checkout instead of pulling the
published release images:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

The build override reuses the production service configuration while tagging
the locally built frontend and backend images with local-only names. Keep both
`-f` arguments on later lifecycle commands too, for example:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml pull postgres
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.build.yml down
```

A plain `docker compose up` uses the published GHCR images instead of the local
build override.

## Application versions

Every pull request needs a version newer than its target branch, including fixes,
documentation and translation changes. Choose a patch, minor or major increase
for the scope, then update all version references together:

```bash
node scripts/bump-version.mjs patch
# Or choose an explicit version, for example:
node scripts/bump-version.mjs 2.0.0 --dry-run
node scripts/check-version.mjs --base origin/main --check-tags
```

Fetch the target branch and release tags before checking. Keep the same proposed
version across further commits unless the target branch catches up or the version
has already been released. The command updates `VERSION`, the frontend package
and lockfile, Docker image defaults, and README references without changing
translations or dependencies.

Only the configured Weblate translation branch receives an automatic patch bump.
Other pull requests choose their own release increment. The check runs on every
PR update and branch push, without file-path exclusions. See
[version automation](docs/VERSIONING.md) for the workflow, permissions and
maintainer activation steps.

## Translations

Partial translations are welcome. Edit the JSON for your language in `frontend/src/i18n/locales/`, keep placeholders such as `{count}` unchanged, and run `npm run check:translations` from `frontend/`. The [translation guide](docs/TRANSLATING.md) explains the files, contributor credit and the planned Hosted Weblate workflow. Browser-based contributions will be linked there once the integration is active.

## Card interfaces

The public card system in `frontend/src/components/card-system` is the normal starting point for card interfaces. It provides established frames, rows, badges, dialogs, and loading/error states so contributors can focus on the feature itself.

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
2. Decide with the reviewer whether the idea is feature-specific or broadly reusable.
3. For a reusable idea, add it to the public card-system module and component gallery.
4. Update the relevant tests and documentation for either approach.

That process gives contributors room to evolve the design while helping accepted improvements remain consistent across features. The guide is reviewed by maintainers; there is no automated rule rejecting an alternative implementation merely because it is new.

## Pull requests

Keep pull requests focused and explain the reason for the change. Include desktop and mobile screenshots for visual work when practical. Reviewers use [`docs/CARD_SYSTEM.md`](docs/CARD_SYSTEM.md) as a consistency checklist and may suggest adapting a contribution to the shared visual language before merge.

Be kind, clear, and assume good intent during review.
