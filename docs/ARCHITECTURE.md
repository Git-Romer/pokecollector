# Architecture Overview

This document reflects the current code layout at the repository root.

## Stack

| Layer | Technology | Port |
|-------|-----------|------|
| Frontend | React 18 + Vite + Tailwind CSS | 3000 |
| Backend | FastAPI | 8000 |
| Database | PostgreSQL 18 | 5432 |
| External APIs | TCGdex, Gemini or OpenAI-compatible scanner, Frankfurter, GitHub, PokéCollector supporter registry | external |
| Containerization | Docker + docker compose | - |

The table lists the default published host ports, set with `FRONTEND_PORT` and `BACKEND_PORT`. Inside the Compose network the frontend listens on `80`, the backend on `8000`, and PostgreSQL on `5432` without being published.

## Directory Structure

```text
pokecollector/
├── backend/
│   ├── main.py
│   ├── database.py
│   ├── models.py
│   ├── schemas.py
│   ├── api/
│   │   ├── auth.py
│   │   ├── backup.py
│   │   ├── binders.py
│   │   ├── cards.py
│   │   ├── collection.py
│   │   ├── community.py
│   │   ├── dashboard.py
│   │   ├── decks.py
│   │   ├── export.py
│   │   ├── github.py
│   │   ├── images.py
│   │   ├── products.py
│   │   ├── profile.py
│   │   ├── public.py
│   │   ├── pokedex.py
│   │   ├── recognize.py
│   │   ├── scan_jobs.py
│   │   ├── settings.py
│   │   ├── sets.py
│   │   ├── social.py
│   │   ├── sync.py
│   │   ├── trades.py
│   │   └── wishlist.py
│   └── services/
│       ├── auth.py
│       ├── card_fallbacks.py
│       ├── card_values.py
│       ├── collection_photos.py
│       ├── deck_allocation.py
│       ├── deck_analysis.py
│       ├── pokemon_api.py
│       ├── pre_upgrade_backup.py
│       ├── printing_details.py
│       ├── public_profile.py
│       ├── scan_queue.py
│       ├── scan_storage.py
│       ├── scan_trace.py
│       ├── scheduler.py
│       ├── sync_service.py
│       ├── tcgdex_languages.py
│       └── telegram.py
├── frontend/
│   ├── src/
│   │   ├── api/client.js
│   │   ├── components/
│   │   │   ├── AppNav.jsx
│   │   │   ├── CardItem.jsx
│   │   │   ├── CardScanner.jsx
│   │   │   ├── Layout.jsx
│   │   │   └── TabNav.jsx
│   │   ├── contexts/
│   │   │   ├── AuthContext.jsx
│   │   │   └── SettingsContext.jsx
│   │   ├── hooks/
│   │   │   └── useTheme.js
│   │   ├── i18n/        # App translation bundles
│   │   ├── utils/       # Shared frontend helpers, including language registries
│   │   └── pages/
│   └── index.html
├── docs/
├── docker-compose.build.yml
├── docker-compose.yml
├── .env.example
├── VERSION
└── README.md
```

Removed from the current architecture:

- no `backend/api/ebay.py`
- no `services/notifications.py`
- no old nested `pokemon-tcg-collection/` directory

## Backend Architecture

### Router Registration

`backend/main.py` registers feature routers under `/api/*`.

The routers cover authentication, cards and scanning, collection state, sets,
wishlist, Card Lists/Decks, products, trades, analytics, Pokédex, public
profiles, backup, synchronization, settings, images, and community data. See
[`BACKEND.md`](BACKEND.md) for the route inventory.

### Data Model

Key ORM models in `backend/models.py`:

- `Set`
- `Card`
- `User`
- `PrintingDetailTag`
- `CollectionItem`
- `CollectionCardPhoto`
- `WishlistItem`
- `Binder`
- `BinderCard`
- `ProductPurchase`
- `ProductCard`
- `ProductLedgerEntry`
- `Trade`
- `TradeItem`
- `SyncLog`
- `PortfolioSnapshot`
- `Setting`
- `UserSetting`
- `CustomCardMatch`
- `ImageCache`
- `ScanJob`
- `ScanJobItem`
- `ScanQueueUserState`
- `GeminiQuotaState`
- `ScannerProviderLimitState`

Notable current model rules:

- `Set.id` and `Card.id` are composite ids with TCGdex language suffixes, including multi-part codes such as `zh-tw` and `pt-br`
- `Card.rarity` comes from TCGdex and is treated as read-only metadata
- Card data, image, and price fallback source languages are tagged when English exact-ID fallback data is used
- Collection variants are limited to physical print variants
- Printing-detail tags are reusable per-user metadata attached to collection,
  product, ledger, and trade records
- Collection-card photos are private, authenticated, and keyed by owner plus
  card identity rather than stored as globally visible catalogue artwork
- `Binder` represents four Card List types: physical Binder, Planned Binder,
  Planned Deck, and Real Deck
- Physical Binders and Real Decks reserve exact collection rows from one shared
  allocation pool; planned lists store requirements without reserving copies
- Product cards and ledger entries retain historical source information when a
  collection row later changes or is removed
- Trades store incoming/outgoing snapshots and collection provenance so safe
  edits can reverse and reapply inventory changes
- Wishlist items store requested quantity from `1` to `99`
- `User.must_change_password` drives the forced password change flow
- `UserSetting` stores per-user preferences and secrets

## Settings Architecture

Settings are split between two stores:

- Global `settings` table
- Per-user `user_settings` table

The split is defined in `backend/api/settings.py`:

- `PER_USER_KEYS`
  - language
  - currency
  - price display preferences
  - Telegram keys and alert preferences
  - Gemini/OpenAI-compatible provider keys and provider-specific scanner choices
  - scanner diagnostics consent
  - preferred owner-card-photo display
  - persisted set filters and hidden-set selections
  - trainer name
- `ADMIN_ONLY_KEYS`
  - full sync interval
  - price sync interval
  - multi-user mode
  - TCGdex sync languages
  - cross-language price/image fallbacks
  - digital-set visibility
  - public-profile master switch
  - debug mode

Effectively:

- normal users can only change their own per-user settings
- admins can also change global operational settings
- per-user settings isolation is enforced in the API layer
- `tcgdex_sync_languages` controls which TCGdex set/card languages full sync fetches. It defaults to `en,de`; extra languages are optional because they increase sync time, API calls, and database size.
- Invalid or empty `TCGDEX_SYNC_LANGUAGES` env values fall back safely to `en,de` during first bootstrap; the env value `all` expands to every supported TCGdex language
- App UI language selection is separate from TCGdex sync-language selection. The UI selector includes all supported TCGdex language codes plus Swedish.
- Public handle, profile publication, and value visibility live on the owning
  `User`; the global feature gate remains an admin-only `Setting`.

## Authentication Architecture

Authentication lives in:

- `backend/api/auth.py`
- `backend/services/auth.py`
- `frontend/src/contexts/AuthContext.jsx`

Current auth model:

- Single-user mode returns the admin user from `get_current_user()` when no token is present
- Multi-user mode requires JWT authentication
- `/api/auth/mode` exposes whether the app is in single-user or multi-user mode
- `must_change_password` is returned by `/api/auth/login` and `/api/auth/me`
- The frontend blocks protected routes until forced password change is completed

## Scanner Flow

Recognition is implemented in `backend/api/recognize.py` and surfaced through `frontend/src/components/UnifiedCardScanner.jsx`, `frontend/src/pages/ScanQueue.jsx`, and the shared add/review components.

Current flow:

1. The user captures or uploads up to 50 photos. Uploads are size-limited, re-encoded, orientation-normalized, stripped of metadata, and stored as private JPEG files.
2. Single photos run individually. Batch-eligible photos are grouped into two-to-four-card composites to reduce provider calls; uncertain composite positions fall back to their original individual photo.
3. The selected Gemini or OpenAI-compatible provider extracts name, split collector number, printed total, set code, regulation mark, type, HP, language, and artist. Unclear small text must be returned as `null`.
4. Candidates are searched against the locally synced `cards` table in the detected language with English fallback. Substring results from either the local catalogue or live TCGdex must still match the complete recognized name after accent, case, and whitespace normalization, preventing collisions such as `Mew`/`Mewtwo` or differing card suffixes from becoming confident number matches. A search pair falls back to a live TCGdex call when it finds no name-compatible local rows, or when a collector number was recognized but none of those rows has that number. This covers both entirely new card names and new printings of existing names while the local sync is behind or still in progress. The fallback result is used for that scan only and is not written back to the catalogue. If every required fallback is unavailable and there is no local candidate, the scan reports a catalogue outage rather than completing with no matches. Candidates from either source are then ranked deterministically by local number, language, printed total, set code, regulation mark, artist, and HP. Missing fields are neutral; contradictions reduce rank.
5. When metadata remains inconclusive, conservative pHash compares the original photo with a bounded candidate set. It accepts only a close, clearly separated winner with no metadata contradiction.
6. Individual scans may use a second provider visual comparison if pHash abstains. Composite scans instead return to the individual queue path. OpenAI-compatible selections must prove their configured endpoint/model before scanning. Models that pass only the single-image probe may be saved by an administrator in acknowledged limited mode, which disables the second visual-comparison step.
7. Results are persisted in the `/scans` review inbox. Before an atomic
   add-and-resolve request, the frontend retains the source bytes in memory.
   When the confirmed card has no reference artwork, it then makes a
   best-effort private owner-photo upload. Confirming or dismissing an item
   deletes its queued photo.
   Unresolved jobs expire after 14 days. Resolved items stay in the review
   payload (collapsed to a compact row) rather than disappearing, so a reviewer
   working through a batch can still see what they just confirmed; the separate
   inbox-list endpoint still excludes fully-resolved jobs. The review UI lets a
   reviewer pan and zoom a candidate against their own photo, and accepting a
   match from that view automatically opens the next unresolved photo in the
   job.

`backend/services/scan_queue.py` provides fair, restart-safe background dispatch with leases. Recognition attempts are capped separately from transient quota failures. Parsed vision results are stored under the active lease before catalogue matching and reused only for catalogue-outage retries, avoiding repeated paid extraction while TCGdex is unavailable; other failure paths discard this temporary cache. Gemini shares quota state by its existing API-key fingerprint so upgrades preserve active pacing and quota blocks. Compatible providers persist blocks under a fingerprint keyed with the resolved private server secret, without storing credentials or administrator endpoint text. Structured daily-quota signals are separated from short-term limits, and provider `Retry-After` / `google.rpc.RetryInfo` delays take precedence over fallback backoff.

Optional diagnostics live in `backend/services/scan_trace.py`. The server must set `SCAN_TRACE_DIR`, and each user must separately enable **Share scanner diagnostics** (off by default). Only opted-in attempts store a sanitized photo plus structured extraction/search/ranking data, including provider and model identifiers. Turning the toggle off stops future traces without deleting old ones; the adjacent delete action removes that user's trace subtree. `SCAN_TRACE_STORAGE_DIR` remains stable when collection is disabled so explicit and account deletion can still find old data. Account deletion writes a revocation marker before cleanup so an in-flight attempt cannot recreate the deleted user's files. No provider key or authentication credential is recorded.

## Frontend State

Current frontend state layers:

- Server state: TanStack Query
- Auth state: `AuthContext`
- Settings and i18n state: `SettingsContext`
- Local UI state: component-level `useState`
- Theme state: `useTheme` with `data-theme` and local storage

`AuthContext` is now a core part of the app architecture, not an optional enhancement.

## Navigation Architecture

- `HomeScreen.jsx` is the compact portal entry point
- `Layout.jsx` wraps protected routes
- `AppNav.jsx` provides the page title strip and logout affordance
- `TabNav.jsx` is the shared section tab component used across major screens
- Card Lists are discovered at `/binders`; legacy `/decks` entry paths redirect
  there, while `/decks/:deckId` and `/decks/compare` remain dedicated tools
- Anonymous public routes live under `/u`; all other feature routes are wrapped
  by the protected layout

## Feature-domain flows

### Card Lists and inventory

`Binder` and `BinderCard` are the shared persistence layer for Binders and
Decks. Planned rows contain a localized card printing and required quantity.
Physical Binders and Real Decks add links to exact collection rows. Allocation
services lock user inventory and enforce capacity across every physical list.
See [`CARD_LISTS.md`](CARD_LISTS.md).

### Products and trades

Sealed products move through `sealed`, `opened`, `sold`, and `review` lifecycle
states. Opening can link collection copies to `ProductCard`; sales and other
gains are captured in `ProductLedgerEntry` so realized and unrealized value can
be calculated separately.

Creating or editing a trade applies incoming/outgoing cards and cash as one
inventory operation. Snapshot/provenance fields allow safe edits while
preserving historical card identity, condition, variant, language, printing
details, and value even if the original collection row later changes.

### Public profiles

Public data is separately serialized by `api/public.py`; anonymous requests do
not reuse authenticated collection responses. Publication requires the global
admin switch, the trainer's profile opt-in, and per-Binder sharing. Market
values require an additional trainer opt-in. Reverse proxies must explicitly
allow only the routes in [`REVERSE_PROXY_AUTH.md`](REVERSE_PROXY_AUTH.md).

## Integrations

### TCGdex

- Set and card source of truth
- Variant availability flags come from TCGdex
- Rarity is read from TCGdex and shown read-only
- Supported sync languages are centralized in `backend/services/tcgdex_languages.py`
- English is the preferred fallback for missing data, images, and prices only when the same exact TCGdex card or set ID exists in English
- Regional-only cards are not guessed by translated name

### Scanner providers

- Gemini is the default; administrators may also enable hosted or self-hosted OpenAI-compatible providers
- Provider communication is isolated behind one shared scanner-provider layer, while matching, visual verification, queueing, and warnings remain provider-neutral
- Users choose only administrator-approved providers and models; administrators can test an Advanced custom model before saving it
- OpenAI-compatible provider/model selections must pass the real-image capability probe; an administrator may explicitly accept single-image-only limited mode, while Gemini keeps its established automatic verification behavior
- Credentials are read per user from `user_settings`; endpoints and approved models remain administrator-controlled
- Transient capacity failures are retried; rate limits, invalid keys, unavailable models, and permanent request failures are reported separately without reflecting arbitrary upstream messages

### Telegram

- Implemented in `backend/services/telegram.py`
- Service accepts `user_id` so alerts use that user's Telegram credentials

### GitHub / Community

- `backend/api/github.py` fetches contributors from the GitHub API
- `backend/api/community.py` is the only client of the versioned public supporter registry at `pokecollector.romerg.de`
- Supporter responses are size-bounded and strictly validated before use; unknown fields, unsafe values, malformed responses, redirects, and upstream failures are rejected
- Supporter data is not persisted or served from a fallback. The Community view fetches on each entry, retains only an in-memory browser cache between entries, and hides cached data while that fetch is pending or after it fails; there is no recurring polling
- `frontend/src/pages/Settings.jsx` renders contributors and the validated supporter projection in the Community section

## Deployment and release architecture

Normal installations use exact-version frontend/backend images from GHCR plus
the official PostgreSQL image. The frontend evaluates `PUBLIC_MODE` at
container startup, so one published artifact supports private and public
installations. Contributors opt into source builds with
`docker-compose.build.yml`.

Changing `VERSION` on `main` triggers the release workflow. It creates a
recoverable draft, builds both application images for `amd64` and `arm64`,
verifies public access, promotes `latest`, uploads deployment assets, and only
then publishes the release. A release-wide concurrency group prevents parallel
publication. See [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Security Notes

- Sync endpoints are admin-only
- Backup and restore are admin-only
- Restore uses `ON_ERROR_STOP` and a single PostgreSQL transaction so a failed
  SQL restore does not leave partially applied data
- Settings keys are separated into admin-only and per-user scopes
- Frontend logout clears local storage and forces a full reload to avoid leaking cached user data across sessions
- User deletion explicitly cleans up user-owned feature data, including
  collection/wishlist rows, Card Lists, products, trades, owner photos,
  portfolio snapshots, and settings. Database scan rows cascade with the user;
  diagnostics are revoked and deleted immediately, while orphaned queued-photo
  directories are removed later by scheduled expiry cleanup.

## Migration Notes

Schema changes are handled by idempotent SQL in `backend/database.py`, not Alembic.

Some migration comments still mention historical features, but the current runtime architecture does not include eBay integration and does not expose grading in the active UI or ORM model.
