# Frontend Reference

React 18 SPA built with Vite. Source lives under `frontend/src/`.

## Route Table

Routes are defined in `frontend/src/App.jsx`.

| Route | Component File | Notes |
|------|----------------|-------|
| `/login` | `pages/Login.jsx` | Multi-user login screen |
| `/` | `pages/HomeScreen.jsx` | Portal-style home screen |
| `/dashboard` | `pages/Dashboard.jsx` | Portfolio summary |
| `/search` | `pages/CardSearch.jsx` | Card search, scanner entry, and multi-select bulk add |
| `/scans` | `pages/ScanQueue.jsx` | Persistent scan inbox |
| `/scans/:jobId` | `pages/ScanQueue.jsx` | Review one queued scan job |
| `/collection` | `pages/Collection.jsx` | User collection |
| `/collection/user/:userId` | `pages/UserCollection.jsx` | Read-only view of another user's collection |
| `/sets` | `pages/Sets.jsx` | Set browser |
| `/sets/:setId` | `pages/SetDetail.jsx` | Set checklist |
| `/wishlist` | `pages/Wishlist.jsx` | Wishlist and alerts |
| `/binders` | `pages/Binders.jsx` | Binder list |
| `/binders/:binderId` | `pages/BinderDetail.jsx` | Binder detail |
| `/analytics` | `pages/Analytics.jsx` | Analytics tabs |
| `/products` | `pages/Products.jsx` | Sealed products |
| `/leaderboard` | `pages/Leaderboard.jsx` | Multi-user leaderboard |
| `/leaderboard/compare/:userId` | `pages/Compare.jsx` | Trainer comparison |
| `/achievements` | `pages/Achievements.jsx` | Current user achievements |
| `/achievements/:userId` | `pages/Achievements.jsx` | Another user's achievements |
| `/settings` | `pages/Settings.jsx` | App settings and admin tools |
| `/migration` | `pages/CardMigration.jsx` | Custom card migration queue |

## Auth Flow

### `AuthContext`

Defined in `frontend/src/contexts/AuthContext.jsx`.

Responsibilities:

- Fetches `/api/auth/mode` on startup
- In single-user mode, attempts `/api/auth/me` without a token
- In multi-user mode, restores user from stored token if present
- Exposes:
  - `user`
  - `loading`
  - `multiUser`
  - `loginUser(token, userData)`
  - `updateCurrentUser(updates)`
  - `logout()`

Security-related behavior:

- `logout()` removes token and user from local storage
- Logout forces a full page reload to clear cached React Query data and prevent cross-user leakage
- Axios also clears auth state on `401`

### Login and Password Change

- `pages/Login.jsx` is only used when `multiUser === true`
- `App.jsx` defines an inline `ForcePasswordChangeScreen`
- If `user.must_change_password` is true, normal app routes are blocked until `/api/auth/me/force-password` succeeds

## Settings & Localization

### `SettingsContext`

Defined in `frontend/src/contexts/SettingsContext.jsx`.

Provides:

- `settings`
- `updateSettings(updates)`
- `t(path)`
- `language`
- `priceDisplay`
- `pricePrimary`
- `pricePrimaryField`
- `currency`
- `currencySymbol`
- `exchangeRate`
- `formatPrice(eurAmount)`
- `formatUsdPrice(usdAmount)`

Notes:

- Translation bundles are loaded from `frontend/src/i18n/` and wired in `SettingsContext`
- UI languages include all supported TCGdex language codes, plus Swedish. Regional variants such as `es-mx`, `pt-br`, `pt-pt`, `zh-tw`, and `zh-cn` are selectable from a compact dropdown in Settings.
- Legacy stored `zh` settings are normalized in the frontend to `zh-cn` for display
- USD display uses exchange rates from the backend Frankfurter endpoint

### `useTheme`

Defined in `frontend/src/hooks/useTheme.js`.

- Stores the selected theme in `localStorage`
- Applies theme via `data-theme` on `document.documentElement`
- Available themes:
  - `default`
  - `fire`
  - `water`
  - `grass`
  - `electric`
  - `psychic`
  - `dragon`
  - `dark`
  - `fairy`

## Navigation

### Home / Portal Navigation

- `pages/HomeScreen.jsx` is the main portal view
- The app now uses a compact navigation pattern with 6 primary portal items on the home screen
- Secondary sections are organized with grouped tabs on individual pages

### `TabNav`

Defined in `frontend/src/components/TabNav.jsx`.

- Reusable horizontal tab bar
- Marks a tab active if the current pathname equals or starts with the tab path
- Used by pages such as `Dashboard`, `Collection`, `Wishlist`, `Binders`, `Analytics`, `Products`, `Leaderboard`, and `Achievements`

### `Layout` and `AppNav`

- `components/Layout.jsx` wraps protected routes
- `components/AppNav.jsx` shows the current page title and multi-user logout control

## Key Screens

### `pages/Login.jsx`

- Multi-user login screen
- Supports quick return to the last signed-in user via `lastUser` and `lastUserAvatar` in local storage

### `pages/Leaderboard.jsx`

- Social ranking view for multi-user mode
- Uses `TabNav`

### `pages/Compare.jsx`

- Side-by-side trainer comparison
- Route parameter: `userId`

### `pages/Achievements.jsx`

- Shows achievements for current user or another user when `:userId` is present

### `pages/Settings.jsx`

- Mixes per-user preferences and admin-only controls
- Admin users can enable multi-user mode from Settings
- When multi-user mode is enabled, admin users see a **Users** tab
- The **Users** tab supports creating users, editing usernames/roles/passwords, activating/deactivating users, deleting other users, and forcing first-login password changes
- Includes:
  - profile name editing
  - avatar picker
  - theme picker
  - app language dropdown and currency controls
  - TCGdex sync-language selection for admins
  - Telegram and Gemini keys
  - per-user scanner diagnostics consent and explicit stored-data deletion
  - sync controls
  - auth mode toggle
  - backup and restore
  - Community sections for contributors and supporters

The supporter section calls the installation's own `/api/community/supporters` endpoint once whenever the Community view is entered. It retains the last valid result only in the browser's in-memory query cache, hides that cache while the entry fetch is pending or after it fails, and performs no timed, background, or focus-based refreshes. The browser never calls the public website registry directly, and no supporter projection is persisted by the installation.

## Card UI

### Shared card system

Feature pages import the public API from `frontend/src/components/card-system`. Its high-level components are `CardDisplay`, `CardRow`, `CardIdentity`, `CardDialog`, `CardLegend`, and `CardStack`.

The system centralizes card structure, borders, image handling, badges, ownership and unavailable states, responsive behavior, and keyboard/touch interactions. Pages supply data, layout, and actions rather than assembling their own card visuals.

Approved `CardDisplay` variants include `grid`, `carousel`, `ranking`, `selectable`, `artwork`, and `compact-artwork`. A development-only component gallery is available at `/__card-system`.

See [`CARD_SYSTEM.md`](CARD_SYSTEM.md) for usage, design tokens, review guidance, and the contributor-friendly process for proposing a new shared variant.

`CardItem.jsx`, `UnifiedCard.jsx`, and the low-level state components remain implementation details of this public system and should not be imported by feature pages.

### `pages/CardSearch.jsx`

- Main search UI for locally cached TCGdex cards and matched custom cards
- Supports select mode for search results
- Can select the current page or all matching search results
- Bulk-add sends selected cards to `/api/collection/bulk-add` with default quantity `1`, condition `NM`, no variant, no purchase price, and the card language
- Bulk-add success toast reports added, updated, and failed counts

### Scanner and review inbox

`components/UnifiedCardScanner.jsx` is the capture-only entry point. It supports the native device camera and gallery uploads, stages one or more photos, allows per-photo individual recognition overrides, and includes an optional positioning guide beside **Take photo**. Every submission enqueues a persistent job and routes to the same review inbox, including a one-photo scan.

`pages/ScanQueue.jsx` and `components/ScanReview.jsx` show job progress, retry countdowns/reasons, sanitized source photos, ranked candidates, failed items, individual retry, dismissal, and collection-add review. The navigation badge counts outstanding items. A confirmed candidate id is sent when resolving an item so opted-in diagnostics can be labelled with human-reviewed ground truth.

Rate-limit countdowns distinguish daily quota from ordinary throttling. Photos remain available only while their item needs review and are deleted on confirmation/dismissal; jobs expire after 14 days.

The AI/Card Scanner section in `pages/Settings.jsx` shows **Share scanner diagnostics** as an available control only when the server configured writable `SCAN_TRACE_DIR` storage. The toggle is off by default. Turning it off stops future tracing without deleting existing data; the adjacent confirmed delete button removes all stored diagnostics for the current user and remains available through the stable cleanup path when new collection is disabled.

## API Layer

`frontend/src/api/client.js` is the central Axios client.

Notable frontend API bindings include:

- auth mode and force-password endpoints
- GitHub community endpoints
- social endpoints for leaderboard / compare / achievements
- selective backup download via `downloadBackup(include)`

## Removed / No Longer Documented

- No eBay integration in the current frontend
- No grading UI in the current frontend
