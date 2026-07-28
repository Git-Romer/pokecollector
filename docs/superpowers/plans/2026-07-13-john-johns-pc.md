# John John's PC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:
> executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the locally hosted Pokemon TCG Tracker into John John's PC, an archive-first Fluent 2 collection
application that preserves all existing collection data and API behavior.

**Architecture:** Retain the FastAPI API, database, existing local Docker override, and existing collection/binder
records. Replace the current portal/dashboard shell with a React Fluent UI v9 archive shell, derive phase-one John John
notes entirely from existing dashboard data, and map Boxes onto binder routes and APIs without a migration.

**Tech Stack:** React 18, Vite, React Router 6, TanStack React Query 5, Tailwind CSS 3, Fluent UI React v9, Lucide
React, FastAPI, pytest.

## Global Constraints

- Product name is exactly `John John's PC`; never expose `Pokemon TCG Tracker` or `Pokemon TCG Collection` in
  user-facing application branding.
- Preserve database schema, `/api/*` endpoint paths, local Docker override behavior, and all existing collection/binder
  records.
- Do not modify or stage `docker-compose.local.yml`.
- The collection is the primary content; prices and market information are contextual only.
- John John is an abstract curator signal, never a chatbot, mascot, human avatar, Pokemon character, or permanent chat
  surface.
- Phase one derives insights locally from existing API data; do not add a generative AI or external market integration.
- Desktop uses Archive, Collection, Boxes, Sets, and Discover; mobile uses the same five destinations in bottom
  navigation.
- Default theme is Midnight Archive; offer an accessible light theme and honor `prefers-reduced-motion`.
- Use Fluent UI v9 components and tokens before custom utility styles. Use custom CSS only for archive-specific effects
  and card presentation.
- Every changed user-facing English string must have an `en.js` key. Existing non-English translations may fall back to
  English until translated in a dedicated localization task.

---

## File Structure

- `frontend/src/design/archiveTheme.js` — Fluent `webDarkTheme`/`webLightTheme` extensions and Midnight Archive semantic
  tokens.
- `frontend/src/design/archive.css` — archive-specific color variables, focus treatments, reduced-motion rules, gallery
  and reveal effects.
- `frontend/src/components/ArchiveShell.jsx` — responsive desktop rail, mobile navigation, global command entry, and
  contextual John John signal.
- `frontend/src/components/JohnJohnSignal.jsx` — accessible abstract presence indicator and optional note trigger.
- `frontend/src/components/ArchiveCommandBar.jsx` — `/` and `Ctrl+K` search overlay that routes to Discover.
- `frontend/src/components/ArchiveNote.jsx` — reusable non-chat curator observation card.
- `frontend/src/utils/archiveInsights.js` — pure derivation of deterministic phase-one Archive Notes.
- `frontend/src/pages/Archive.jsx` — default route and collection-first opening experience.
- `frontend/src/pages/Boxes.jsx` — Boxes presentation over existing `/api/binders/` data.
- `frontend/src/pages/Discover.jsx` — unified search/scanner/wishlist entry view built from existing flows.
- `frontend/src/App.jsx` — Fluent provider, canonical routes, and legacy redirects.
- `frontend/src/main.jsx` — theme bootstrap and toast presentation.
- `frontend/src/hooks/useTheme.js` — two-theme Midnight Archive/light preference model.
- `frontend/src/i18n/en.js` — canonical product and archive copy keys.
- `frontend/src/pages/Collection.jsx`, `Sets.jsx`, `SetDetail.jsx`, `Binders.jsx`, `CardSearch.jsx`, `Wishlist.jsx` —
  refit existing data views to the new labels and shell.
- `frontend/index.html`, `frontend/public/manifest.json`, `frontend/public/john-john-mark.svg` — browser/PWA branding.
- `frontend/package.json`, `frontend/vite.config.js`, `frontend/src/test/setup.js`, `frontend/src/**/*.test.jsx` —
  frontend test stack and focused UI tests.
- `backend/main.py`, `backend/tests/test_health.py` — API documentation branding and stable health contract.

## Task 1: Establish the Fluent archive foundation and test harness

**Files:**

- Modify: `frontend/package.json`
- Modify: `frontend/vite.config.js`
- Modify: `frontend/src/main.jsx`
- Modify: `frontend/src/hooks/useTheme.js`
- Modify: `frontend/tailwind.config.js`
- Modify: `frontend/src/index.css`
- Create: `frontend/src/design/archiveTheme.js`
- Create: `frontend/src/design/archive.css`
- Create: `frontend/src/test/setup.js`
- Create: `frontend/src/hooks/useTheme.test.jsx`

**Interfaces:**

- Produces `ARCHIVE_THEME_STORAGE_KEY`, `ARCHIVE_THEMES`, and `useTheme()` returning `{ theme, setTheme, themes }` where
  theme is `midnight` or `light`.
- Produces `archiveDarkTheme` and `archiveLightTheme` for Fluent `FluentProvider`.
- Consumes no backend contracts.

- [ ] **Step 1: Add the frontend test and Fluent dependencies**

  In `frontend/package.json`, add these exact dependencies and scripts:

  ```json
  {
    "scripts": {
      "test": "vitest run",
      "test:watch": "vitest"
    },
    "dependencies": {
      "@fluentui/react-components": "^9.72.0",
      "@fluentui/react-icons": "^2.0.290"
    },
    "devDependencies": {
      "@testing-library/jest-dom": "^6.6.3",
      "@testing-library/react": "^16.1.0",
      "@testing-library/user-event": "^14.6.1",
      "jsdom": "^25.0.1",
      "vitest": "^3.0.5"
    }
  }
  ```

  Extend `vite.config.js` with `test: { environment: 'jsdom', setupFiles: './src/test/setup.js', globals: true }`.

- [ ] **Step 2: Write the failing theme persistence test**

  Create `frontend/src/hooks/useTheme.test.jsx`:

  ```jsx
  import { renderHook, act } from '@testing-library/react'
  import { ARCHIVE_THEME_STORAGE_KEY, useTheme } from './useTheme'

  test('persists the selected archive theme and applies it to the document root', () => {
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setTheme('light'))
    expect(localStorage.getItem(ARCHIVE_THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
  ```

- [ ] **Step 3: Run the test to verify it fails**

  Run: `npm --prefix frontend test -- useTheme.test.jsx`

  Expected: FAIL because `ARCHIVE_THEME_STORAGE_KEY` and the new theme model do not exist.

- [ ] **Step 4: Implement the archive theme contract**

  Replace the type-theme array in `frontend/src/hooks/useTheme.js` with:

  ```jsx
  export const ARCHIVE_THEME_STORAGE_KEY = 'john-johns-pc-theme'
  export const ARCHIVE_THEMES = [
    { id: 'midnight', label: 'Midnight Archive' },
    { id: 'light', label: 'Daylight Archive' },
  ]
  ```

  Initialize from `ARCHIVE_THEME_STORAGE_KEY`, default to `midnight`, set
  `document.documentElement.dataset.theme = theme`, and return `themes: ARCHIVE_THEMES`.

  Create `archiveTheme.js` using Fluent `webDarkTheme`, `webLightTheme`, and `createLightTheme`/`createDarkTheme` token
  overrides. Export `archiveDarkTheme` and `archiveLightTheme`; give the dark theme a navy-black page background and
  electric-blue brand tokens. In `main.jsx`, wrap the app in `FluentProvider` and choose the exported theme from
  `useTheme` through a small `ThemedApp` component.

  Create `archive.css` with CSS variables for archive canvas/surface/border/signal colors, `:focus-visible` outline
  rules, `@media (prefers-reduced-motion: reduce)` that removes animation and transition durations, and
  `data-theme="light"` values. Import it after `index.css`.

  Remove the type-specific `[data-theme]` blocks and Pokemon-type theme picker assumptions from `index.css` and
  `tailwind.config.js`; retain generic semantic Tailwind aliases that existing pages still consume.

- [ ] **Step 5: Add the Vitest setup file**

  Create `frontend/src/test/setup.js`:

  ```js
  import '@testing-library/jest-dom/vitest'
  ```

- [ ] **Step 6: Run the focused and production checks**

  Run: `npm --prefix frontend test -- useTheme.test.jsx && npm --prefix frontend run build`

  Expected: the theme test passes and Vite completes with `✓ built`.

- [ ] **Step 7: Commit the foundation**

  ```bash
  git add frontend/package.json frontend/package-lock.json frontend/vite.config.js frontend/src/main.jsx frontend/src/hooks/useTheme.js frontend/src/hooks/useTheme.test.jsx frontend/src/design frontend/src/test frontend/src/index.css frontend/tailwind.config.js
  git commit -m "feat: establish John John's PC Fluent foundation"
  ```

## Task 2: Build the canonical Archive shell, navigation, and route compatibility

**Files:**

- Create: `frontend/src/components/ArchiveShell.jsx`
- Create: `frontend/src/components/ArchiveCommandBar.jsx`
- Create: `frontend/src/components/JohnJohnSignal.jsx`
- Create: `frontend/src/components/ArchiveShell.test.jsx`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/components/Layout.jsx`
- Modify: `frontend/src/components/AppNav.jsx`
- Modify: `frontend/src/components/BottomNav.jsx`
- Modify: `frontend/src/i18n/en.js`

**Interfaces:**

- `ArchiveShell` renders its nested `<Outlet />` and uses `PRIMARY_ARCHIVE_NAV` with exactly `/`, `/collection`,
  `/boxes`, `/sets`, `/discover`.
- `ArchiveCommandBar` accepts `{ open, onClose }` and routes submitted text to
  `/discover?q=${encodeURIComponent(query)}`.
- `JohnJohnSignal` accepts `{ noteCount, onOpenNotes }` and has an accessible `aria-label="Open Archive Notes"`.
- Legacy `/dashboard` redirects to `/`; `/binders` and `/binders/:binderId` redirect to `/boxes` and `/boxes/:binderId`;
  `/search` redirects to `/discover`.

- [ ] **Step 1: Write the shell and redirect tests**

  Create `ArchiveShell.test.jsx` with a `MemoryRouter` test that asserts all five navigation labels are present, then
  render `App` at `/dashboard` and assert the canonical Archive heading is shown after redirect. Mock auth/settings
  providers with a signed-in single-user fixture.

  ```jsx
  expect(screen.getByRole('link', { name: 'Archive' })).toBeVisible()
  expect(screen.getByRole('link', { name: 'Boxes' })).toBeVisible()
  expect(await screen.findByRole('heading', { name: 'Your Archive' })).toBeVisible()
  ```

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `npm --prefix frontend test -- ArchiveShell.test.jsx`

  Expected: FAIL because the Archive shell and legacy redirects do not exist.

- [ ] **Step 3: Implement the responsive shell**

  Create `ArchiveShell.jsx` using Fluent `NavDrawer`, `Toolbar`, `Button`, `Badge`, and `Drawer`. Use Lucide or Fluent
  icons for the five fixed destinations. Render a desktop rail at `lg` and the equivalent five-item bottom navigation
  below `lg`. Put `JohnJohnSignal` in the contextual header/rail; do not render a chat panel.

  Create `ArchiveCommandBar.jsx` with Fluent `Dialog`, `Input`, and `SearchRegular`. Add one `keydown` listener that
  opens for `/` when the target is not an input, textarea, or contenteditable element, and opens for `Ctrl+K` or
  `Meta+K`. Its form submits to Discover and closes the dialog.

  Create `JohnJohnSignal.jsx` as a small button with an abstract JJ glyph, a presence dot, and `prefers-reduced-motion`
  safe CSS. It opens notes only when `noteCount > 0`; otherwise it is a labelled passive status indicator.

- [ ] **Step 4: Replace routes and old navigation**

  In `App.jsx`, make `/` the lazy `Archive` route, `/boxes` the lazy `Boxes` route, and `/discover` the lazy `Discover`
  route. Add `<Navigate replace>` aliases for `/dashboard`, `/search`, `/binders`, and `/binders/:binderId`; preserve
  query strings when redirecting `/search` to `/discover`.

  Replace `Layout` with `ArchiveShell`; remove the floating Pokeball home button from `AppNav`; replace `BottomNav`'s
  four-plus-More model with the same five primary destinations as `ArchiveShell`. Update English keys to expose
  `nav.archive`, `nav.boxes`, `nav.discover`, `archive.search`, and `archive.notes`.

- [ ] **Step 5: Run shell tests and build**

  Run: `npm --prefix frontend test -- ArchiveShell.test.jsx && npm --prefix frontend run build`

  Expected: PASS and successful build.

- [ ] **Step 6: Commit the navigation transition**

  ```bash
  git add frontend/src/components/ArchiveShell.jsx frontend/src/components/ArchiveCommandBar.jsx frontend/src/components/JohnJohnSignal.jsx frontend/src/components/ArchiveShell.test.jsx frontend/src/App.jsx frontend/src/components/Layout.jsx frontend/src/components/AppNav.jsx frontend/src/components/BottomNav.jsx frontend/src/i18n/en.js
  git commit -m "feat: introduce the John John's PC archive shell"
  ```

## Task 3: Deliver the Archive home and deterministic John John notes

**Files:**

- Create: `frontend/src/pages/Archive.jsx`
- Create: `frontend/src/components/ArchiveNote.jsx`
- Create: `frontend/src/utils/archiveInsights.js`
- Create: `frontend/src/utils/archiveInsights.test.js`
- Modify: `frontend/src/pages/HomeScreen.jsx` (delete after moving reusable card thumbnail code)
- Modify: `frontend/src/api/client.js` only if an existing dashboard helper needs a named re-export

**Interfaces:**

- `deriveArchiveInsights({ recentAdditions, ownedSets, totalCards, sets })` returns ordered objects
  `{ id, kind, title, body, href }` with a maximum of three notes.
- `Archive` consumes the existing `getDashboard({ price_field })` response and existing set query; no new endpoint is
  introduced.

- [ ] **Step 1: Write failing deterministic insight tests**

  Create `archiveInsights.test.js`:

  ```js
  import { deriveArchiveInsights } from './archiveInsights'

  test('creates a near-completion note without price analysis', () => {
    const notes = deriveArchiveInsights({
      totalCards: 42,
      ownedSets: 1,
      recentAdditions: [],
      sets: [{ id: 'sv1', name: 'Scarlet & Violet', owned_count: 196, total: 198 }],
    })
    expect(notes[0]).toMatchObject({
      kind: 'near-completion',
      body: 'Only two cards left in Scarlet & Violet.',
      href: '/sets/sv1',
    })
  })
  ```

- [ ] **Step 2: Run the utility test to verify it fails**

  Run: `npm --prefix frontend test -- archiveInsights.test.js`

  Expected: FAIL because `deriveArchiveInsights` does not exist.

- [ ] **Step 3: Implement local-only insight derivation**

  Implement `deriveArchiveInsights` with these exact priority rules:

    1. A set at 90–99% completion produces `Only ${remaining} card(s) left in ${name}.`
    2. A completed set produces `${name} is complete. Filed.`
    3. A recent addition produces `I've had my eye on ${card.name}.`
    4. A collection count divisible by 100 produces `${totalCards} cards. The archive is growing nicely.`

  Use plural-safe wording and never use price, portfolio, market, AI, task, or query language. Deduplicate IDs and
  return at most three notes.

- [ ] **Step 4: Build the Archive page from existing data**

  Replace the current portfolio-value home experience with `Archive.jsx`. Query `getDashboard` and `getSets`, then
  render in this order:

    1. `Your Archive` heading with one short curator subtitle.
    2. A Featured Card / Set surface using `recent_additions[0]`, falling back to the highest completion set.
    3. Recent Additions gallery using existing `CardImage` and `collectionItemTargetUrl`.
    4. Set Progress shelf using the three closest-to-complete sets.
    5. `ArchiveNote` cards from `deriveArchiveInsights`.

  Do not render portfolio value, P&L, investment charts, top-value cards, or price-sync controls on Archive. Keep admin
  sync controls only in Settings.

  Add `ArchiveNote.jsx` as a Fluent `Card` with the abstract JJ signal, title, body, and one route link. It must use an
  `article` element and no text input.

- [ ] **Step 5: Run focused checks**

  Run: `npm --prefix frontend test -- archiveInsights.test.js && npm --prefix frontend run build`

  Expected: PASS and successful build.

- [ ] **Step 6: Commit the Archive experience**

  ```bash
  git add frontend/src/pages/Archive.jsx frontend/src/components/ArchiveNote.jsx frontend/src/utils/archiveInsights.js frontend/src/utils/archiveInsights.test.js frontend/src/pages/HomeScreen.jsx frontend/src/api/client.js
  git commit -m "feat: add collection-first Archive and John John notes"
  ```

## Task 4: Reframe Boxes, Sets, Collection, and Discover without data migration

**Files:**

- Create: `frontend/src/pages/Boxes.jsx`
- Create: `frontend/src/pages/Discover.jsx`
- Create: `frontend/src/pages/Boxes.test.jsx`
- Modify: `frontend/src/pages/Binders.jsx`
- Modify: `frontend/src/pages/BinderDetail.jsx`
- Modify: `frontend/src/pages/Collection.jsx`
- Modify: `frontend/src/pages/Sets.jsx`
- Modify: `frontend/src/pages/SetDetail.jsx`
- Modify: `frontend/src/pages/CardSearch.jsx`
- Modify: `frontend/src/pages/Wishlist.jsx`
- Modify: `frontend/src/components/CardItem.jsx`
- Modify: `frontend/src/components/TabNav.jsx`
- Modify: `frontend/src/i18n/en.js`

**Interfaces:**

- `Boxes` calls existing `getBinders`, `createBinder`, `updateBinder`, and `deleteBinder` helpers unchanged.
- `Discover` routes users to existing card search, scanner, and wishlist behavior; no duplicate card-write endpoint is
  created.
- Collection preserves the existing query keys and collection editing actions.

- [ ] **Step 1: Write the failing Boxes mapping test**

  Create `Boxes.test.jsx` with mocked `getBinders` data. Assert that a returned binder named `Illustration Rares` is
  rendered as a Box and that the create action reads `New Box`, while the underlying mutation is still `createBinder`.

- [ ] **Step 2: Run the test to verify it fails**

  Run: `npm --prefix frontend test -- Boxes.test.jsx`

  Expected: FAIL because `Boxes` does not exist.

- [ ] **Step 3: Implement Boxes over binders**

  Create `Boxes.jsx` by extracting the existing binder query/mutation behavior into a collection-first Box gallery.
  Rename visible terms only: `Binder` → `Box`, `New Binder` → `New Box`, and `Binder details` → `Box details`. Keep
  binder IDs, mutation names, and API calls unchanged. Route a Box detail to `/boxes/:binderId` and retain
  `/binders/:binderId` as a redirect alias.

  Update `BinderDetail.jsx` headings, breadcrumbs, and action labels to Box language without changing card ordering,
  entry-editing, or print optimization behavior.

- [ ] **Step 4: Refit collection and set presentation**

  Keep Collection's existing filters, bulk actions, and data requests. Make gallery mode the default with the existing
  compact list mode retained behind a view control. Ensure every tile is keyboard reachable and opens the existing
  detail surface.

  In `Sets.jsx` and `SetDetail.jsx`, preserve existing filtering/checklist behavior but replace HP-style progress
  treatment with neutral Fluent progress bars, missing-card counts, and `Set Shelf` wording. Keep completion percentages
  secondary and retain all set visibility controls.

- [ ] **Step 5: Implement Discover as an orchestration page**

  Create `Discover.jsx` with three prominent actions: `Search cards`, `Scan a card`, and `Open wishlist`. The search
  form must navigate to the existing card search route with the `q` query parameter. The scanner action must route to
  the existing scanner entry in `CardSearch`; do not move recognition logic. The wishlist action routes to the existing
  wishlist page.

  Update `CardSearch.jsx` and `Wishlist.jsx` headers and back links to refer to Discover while preserving existing add,
  bulk-add, wishlist, and alert requests.

- [ ] **Step 6: Run UI tests and production build**

  Run: `npm --prefix frontend test -- Boxes.test.jsx && npm --prefix frontend run build`

  Expected: PASS and successful build.

- [ ] **Step 7: Commit the core-space adaptation**

  ```bash
  git add frontend/src/pages/Boxes.jsx frontend/src/pages/Discover.jsx frontend/src/pages/Boxes.test.jsx frontend/src/pages/Binders.jsx frontend/src/pages/BinderDetail.jsx frontend/src/pages/Collection.jsx frontend/src/pages/Sets.jsx frontend/src/pages/SetDetail.jsx frontend/src/pages/CardSearch.jsx frontend/src/pages/Wishlist.jsx frontend/src/components/CardItem.jsx frontend/src/components/TabNav.jsx frontend/src/i18n/en.js
  git commit -m "feat: make boxes and discovery collection-first"
  ```

## Task 5: Replace product metadata and API documentation branding

**Files:**

- Modify: `frontend/index.html`
- Modify: `frontend/public/manifest.json`
- Create: `frontend/public/john-john-mark.svg`
- Modify: `frontend/Dockerfile`
- Modify: `frontend/package.json`
- Modify: `backend/main.py`
- Create: `backend/tests/test_health.py`

**Interfaces:**

- Browser title is `John John's PC`.
- Manifest `name` is `John John's PC`; `short_name` is `John John's PC`.
- FastAPI title is `John John's PC API`; `/api/health` remains `{ "status": "ok", "service": "pokemon-tcg-collection" }`
  to avoid a service-contract change.

- [ ] **Step 1: Write the failing API documentation/health test**

  Create `backend/tests/test_health.py`:

  ```python
  from fastapi.testclient import TestClient
  from main import app

  def test_health_contract_and_openapi_branding():
      client = TestClient(app)
      assert client.get('/api/health').json() == {
          'status': 'ok', 'service': 'pokemon-tcg-collection'
      }
      assert client.get('/openapi.json').json()['info']['title'] == "John John's PC API"
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `pytest backend/tests/test_health.py -v`

  Expected: FAIL because the FastAPI title is still `Pokemon TCG Collection API`.

- [ ] **Step 3: Update browser, PWA, and API branding**

  In `index.html`, set title to `John John's PC`, replace Pokemon favicon references with `/john-john-mark.svg`, use a
  Midnight Archive theme color, and remove the Google Inter import in favor of Segoe UI Variable/system font stacks.

  In `manifest.json`, set name, short_name, description, icon references, and theme/background colors for John John's
  PC. Create `john-john-mark.svg` as an original, simple JJ monogram with no Pokeball or Pokemon logo shapes.

  Replace Dockerfile metadata substitutions so production metadata uses John John's PC and never injects PokéCollector
  copy. Rename package name to `john-johns-pc`.

  In `backend/main.py`, update startup logging, `FastAPI(title=...)`, and description to John John's PC. Do not change
  router prefixes, the health service identifier, scheduler names, debug log names, or upstream repository references.

- [ ] **Step 4: Run branding checks**

  Run: `pytest backend/tests/test_health.py -v && npm --prefix frontend run build`

  Expected: PASS and successful build.

- [ ] **Step 5: Commit branded metadata**

  ```bash
  git add frontend/index.html frontend/public/manifest.json frontend/public/john-john-mark.svg frontend/Dockerfile frontend/package.json frontend/package-lock.json backend/main.py backend/tests/test_health.py
  git commit -m "feat: brand the local archive as John John's PC"
  ```

## Task 6: Validate locally hosted behavior, accessibility, and regression safety

**Files:**

- Modify: `docs/FRONTEND.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `README.md`

**Interfaces:**

- Documents canonical app name, five primary spaces, old-route redirects, local-first insight boundary, and unchanged
  local Docker override ownership.

- [ ] **Step 1: Add documentation acceptance criteria**

  Update `docs/FRONTEND.md` route table with Archive, Boxes, and Discover. Record legacy aliases and explicitly state
  that Boxes use existing binders in phase one.

  Update `docs/ARCHITECTURE.md` to state that John John notes are derived in the frontend from existing collection
  endpoints and that no data is sent to AI services in phase one.

  Update the local-use section of `README.md` to call the app John John's PC without changing upstream repository clone
  or contribution instructions.

- [ ] **Step 2: Run all automated checks**

  Run:

  ```bash
  npm --prefix frontend test
  npm --prefix frontend run build
  pytest backend/tests -v
  ```

  Expected: all frontend tests pass, Vite builds, and the backend suite passes.

- [ ] **Step 3: Run live smoke checks against the local stack**

  Run:

  ```bash
  Invoke-WebRequest http://127.0.0.1:13000 -UseBasicParsing | Select-Object -ExpandProperty StatusCode
  Invoke-WebRequest http://127.0.0.1:18080/openapi.json -UseBasicParsing | Select-Object -ExpandProperty Content
  ```

  Expected: frontend status `200`; OpenAPI info title `John John's PC API`.

  In a browser, verify `/`, `/dashboard`, `/collection`, `/boxes`, `/binders`, `/sets`, `/discover`, and `/search` load
  or redirect as specified. Verify keyboard tab order, visible focus styles, `/` and `Ctrl+K` command opening,
  card-detail behavior, mobile-width navigation, light mode, and reduced-motion behavior.

- [ ] **Step 4: Confirm the protected local override is untouched**

  Run: `git status --short`

  Expected: `docker-compose.local.yml` remains untracked and unstaged; only intentional documentation or implementation
  changes appear.

- [ ] **Step 5: Commit validation documentation**

  ```bash
  git add docs/FRONTEND.md docs/ARCHITECTURE.md README.md
  git commit -m "docs: document John John's PC archive workflow"
  ```
