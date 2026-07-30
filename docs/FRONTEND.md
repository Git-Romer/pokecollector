# Frontend Reference

React 18 SPA built with Vite. Source lives under `frontend/src/`.

## Route Table

Routes are defined in `frontend/src/App.jsx`.

| Route                          | Component File             | Notes                                                                       |
|--------------------------------|----------------------------|-----------------------------------------------------------------------------|
| `/login`                       | `pages/Login.jsx`          | Multi-user login screen                                                     |
| `/`                            | `pages/Home.jsx`           | My Collection overview and John John presence                               |
| `/dashboard`                   | Redirects to `/`           | Legacy collection-overview route                                            |
| `/search`                      | `pages/CardSearch.jsx`     | Card search, scanner entry, and multi-select bulk add                       |
| `/card-search`                 | Redirects to `/search`     | Legacy search route; query string is preserved                              |
| `/collection`                  | `pages/Collection.jsx`     | User collection                                                             |
| `/collection/user/:userId`     | `pages/UserCollection.jsx` | Read-only view of another user's collection                                 |
| `/all-cards`                   | `pages/Sets.jsx`           | All Cards master-set browser                                                |
| `/all-cards/:setId`            | `pages/SetDetail.jsx`      | All Cards set checklist                                                     |
| `/sets`                        | Redirects to `/all-cards`  | Legacy set-browser route                                                     |
| `/sets/:setId`                 | Redirects to `/all-cards/:setId` | Legacy set-detail route                                                |
| `/wishlist`                    | `pages/Wishlist.jsx`       | Chase Cards and alerts                                                      |
| `/binders`                     | `pages/Binders.jsx`        | Contextual binder/storage surface                                           |
| `/binders/:binderId`           | `pages/BinderDetail.jsx`   | Binder detail                                                               |
| `/trends`                      | `pages/Analytics.jsx`      | Trends & Insights tabs                                                      |
| `/analytics`                   | Redirects to `/trends`     | Legacy analytics route                                                      |
| `/products`                    | `pages/Products.jsx`       | Sealed products                                                             |
| `/leaderboard`                 | `pages/Leaderboard.jsx`    | Multi-user leaderboard                                                      |
| `/leaderboard/compare/:userId` | `pages/Compare.jsx`        | Trainer comparison                                                          |
| `/achievements`                | `pages/Achievements.jsx`   | Current user achievements                                                   |
| `/achievements/:userId`        | `pages/Achievements.jsx`   | Another user's achievements                                                 |
| `/settings`                    | `pages/Settings.jsx`       | App settings and admin tools                                                |
| `/migration`                   | `pages/CardMigration.jsx`  | Custom card migration queue                                                 |

## John John's PC Shell

The active shell is `components/ArchiveShell.jsx`. Its primary navigation is intentionally fixed to five familiar
destinations:

1. Collection
2. Card Search
3. All Cards
4. Trends & Insights
5. Settings

Older routes such as `/sets`, `/analytics`, `/binders`, `/products`, `/wishlist`, `/leaderboard`, and
`/achievements` remain reachable as contextual or legacy surfaces, but they are not primary navigation items. The root
route enters My Collection, not a portfolio dashboard.

## Privacy & Data UI

Settings includes a **Privacy & Data** panel backed by
`src/utils/privacyData.js`. It states the local-first operating boundary:

- John John’s Notes are derived locally from tracker data.
- External AI is disabled by default and requires explicit opt-in.
- HoloDex, Collectr, PSA, TAG, and CSV data are manual/reviewed imports.
- Excel export is the local portable backup format.

Scheduled workbook backups are intentionally deferred. Do not enable them until the export endpoint passes a live smoke
check and the user approves a visible local destination.

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
- UI languages include all supported TCGdex language codes, plus Swedish. Regional variants such as `es-mx`, `pt-br`,
  `pt-pt`, `zh-tw`, and `zh-cn` are selectable from a compact dropdown in Settings.
- Legacy stored `zh` settings are normalized in the frontend to `zh-cn` for display
- USD display uses exchange rates from the backend Frankfurter endpoint

### `useTheme`

Defined in `frontend/src/hooks/useTheme.js`.

- Dark-only compatibility shim for John John's PC.
- Stores `midnight` in `localStorage` for older callers.
- Applies `data-theme="midnight"` on `document.documentElement`.
- There is no light theme, alternate color theme picker, or reduced-motion mode in this release.

## Navigation

### John John's PC Shell Navigation

- `components/ArchiveShell.jsx` owns the desktop shell.
- Primary navigation is fixed to Collection, Card Search, All Cards, Trends & Insights, and Settings.
- Root enters `pages/Home.jsx` as the My Collection overview; legacy dashboard routes redirect to `/`.
- Narrow screens show the desktop-workspace gate instead of a mobile navigation surface.

### `TabNav`

Defined in `frontend/src/components/TabNav.jsx`.

- Reusable horizontal tab bar
- Marks a tab active if the current pathname equals or starts with the tab path
- Used by pages such as `Dashboard`, `Collection`, `Wishlist`, `Binders`, `Analytics`, `Products`, `Leaderboard`, and
  `Achievements`

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
- The **Users** tab supports creating users, editing usernames/roles/passwords, activating/deactivating users, deleting
  other users, and forcing first-login password changes
- Includes:
    - profile name editing
    - avatar picker
    - theme picker
    - app language dropdown and currency controls
    - TCGdex sync-language selection for admins
    - Telegram and Gemini keys
    - sync controls
    - auth mode toggle
    - backup and restore
    - Community sections for contributors and supporters

## Card UI

### `CardItem` / `CardModal`

Defined in `frontend/src/components/CardItem.jsx`.

Current behavior:

- `CardItem` renders the card tile
- `CardModal` displays detailed pricing, price history, metadata, and add-to-collection actions
- Rarity is displayed as read-only API metadata
- Variant selection is limited to:
    - `Normal`
    - `Holo`
    - `Reverse Holo`
    - `First Edition`
- Variant auto-preselect logic:
    - preselects the only available variant if there is exactly one
    - defaults to `Holo` when holo exists without normal or reverse
- Shows available variants from TCGdex flags

### `pages/CardSearch.jsx`

- Main search UI for locally cached TCGdex cards and matched custom cards
- Supports select mode for search results
- Can select the current page or all matching search results
- Bulk-add sends selected cards to `/api/collection/bulk-add` with default quantity `1`, condition `NM`, no variant, no
  purchase price, and the card language
- Bulk-add success toast reports added, updated, and failed counts

### `CardScanner`

Defined in `frontend/src/components/CardScanner.jsx`.

- Upload/camera capture flow
- Calls `/api/cards/recognize`
- Displays recognized matches, including rarity
- Shows clearer scanner errors returned by the backend for Gemini rate limits, invalid keys, and temporary capacity
  outages
- Lets the user add a matched card to the collection
- Supports language selection in the add modal through the shared TCGdex language selector

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
