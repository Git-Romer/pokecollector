# ⚠️ Disclaimer
Everything below (and in this repo) is unapologetically vibecoded.
Expect vibes, not guarantees. Proceed with good humor and version control.

Contributions are welcome. Open a pull request for fixes, features, or docs. Not sure where to start? Open an issue and we'll chat. Small improvements are great.

Found a bug or have an idea? Open an issue. Include steps to reproduce, expected vs. actual behavior. Screenshots or logs help.

Fork, branch, and submit a focused PR. Add or update tests and docs as needed. Explain the "why" and link related issues. Make sure checks pass.

Be kind. Be clear. Assume good intent. Keep feedback constructive.

# 🃏 PokéCollector

> A self-hosted, full-stack Pokémon TCG collection manager for cards, sealed products, binders, analytics, scanning, and multi-user collections.

- 🌐 **Website:** [pokecollector.romerg.de](https://pokecollector.romerg.de/)
- 👤 **Creator:** [Gilles Romer](https://romerg.de/)
- ✉️ **Contact:** [info@romerg.de](mailto:info@romerg.de)

![Version](https://img.shields.io/badge/version-v1.40.0-e3000b?style=flat-square) ![Dark Theme](https://img.shields.io/badge/theme-dark-1a1a2e?style=flat-square) ![TCGdex](https://img.shields.io/badge/card%20data-TCGdex-e3000b?style=flat-square) ![Docker](https://img.shields.io/badge/deploy-Docker-2496ed?style=flat-square) ![FastAPI](https://img.shields.io/badge/backend-FastAPI-009688?style=flat-square) ![React](https://img.shields.io/badge/frontend-React%2018-61dafb?style=flat-square) [![Support animal rescue](https://img.shields.io/badge/support-animal%20rescue-e3000b?style=flat-square)](https://pokecollector.romerg.de/#support)

**Current version:** `v1.40.0` · Releases are tracked on the [GitHub Releases page](https://github.com/Git-Romer/pokecollector/releases).

![WebApp Preview](preview-homescreen.png)

---

## 📑 Table of Contents

- [Features](#-features)
- [Quick Start](#-quick-start)
- [Reverse Proxy Authentication](#-reverse-proxy-authentication)
- [Managing Users](#-managing-users)
- [Environment Variables](#-environment-variables)
- [Sync Behavior](#-sync-behavior)
- [Architecture](#-architecture)
- [Tech Stack](#-tech-stack)
- [External Sources](#-external-sources)
- [Documentation](#-documentation)
- [Configuration Reference](#-configuration-reference)
- [Updating](#-updating)
- [Community Projects](#-community-projects)
- [Support](#-support)
- [License](#-license)

---

## ✨ Features

### 📦 Collection Management
- Add cards with quantity, condition, variant, and purchase price
- Variants are now limited to `Normal`, `Holo`, `Reverse Holo`, and `First Edition`
- Card rarity is read-only from TCGdex and displayed separately from variant
- Track localized TCGdex card rows separately by language code, including all supported TCGdex languages
- Manually create owner-scoped custom cards not present in TCGdex
- Share manual cards as copy-only templates so other trainers receive independent cards and portfolio values

### 🔍 Search & Scanning
- Search the locally cached card database by name, set, type, rarity, HP, artist, and more
- Short-code search like `PFL 001`
- Multi-select search results and bulk-add matching cards to the collection
- Unified persistent scanner with individual and composite batch recognition, via Gemini or any OpenAI-compatible vision endpoint
- Persistent, restart-safe scan queue with a review inbox, 14-day expiry, and automatic retries that do not consume recognition attempts for rate limits
- Shared provider quota handling honors reset metadata and prevents queued scans from repeatedly hitting a blocked key or local endpoint; Gemini keeps its existing daily-quota classification and pacing
- Deterministic matching ranks local number, printed total, set code, regulation mark, artist, and HP before optional visual verification
- Conservative local pHash matching can resolve exceptionally clear candidates without a second Gemini request and safely abstains on ambiguous photos
- Native camera and gallery capture with an optional positioning guide; queued photos are sanitized and deleted after confirmation or dismissal
- Scanner strips suffixes like `ex` / `GX` / `VSTAR` for broader matching
- Optional consent-controlled scanner diagnostics for installations that enable `SCAN_TRACE_DIR`; disabled per user by default with a separate delete action
- Card modal auto-preselects a likely variant from TCGdex variant flags

### 🗂️ Sets, Binders & Wishlist
- Set overview with completion progress and per-set checklist
- National Pokédex #001–1025 with generation filters, species completion, locally cached sprites/artwork, and click-through card printings
- Virtual binders for collection and checklist views
- Exact-copy quantities in collection binders, with cross-binder allocation limits and total/unique counts
- Wishlist with Telegram price alerts

### 📈 Prices, Portfolio & Analytics
- Cardmarket EUR pricing and TCGPlayer USD pricing via TCGdex
- Price history charts and portfolio snapshots
- Dashboard, duplicates, top movers, rarity stats, and investment tracker
- Sealed product tracking with realized and unrealized P&L

### 👤 Single-User & Multi-User
- Single-user mode: no login required, auto-auth as admin
- Multi-user mode: JWT login, admin/trainer roles, separate user data
- Per-user settings for language, currency, Telegram keys, and scanner provider keys
- Force password change support on first login
- Profile avatar and profile name editing
- Cascade deletion of user-owned data

### 🏆 Social & Community
- Leaderboard, trainer comparison, and achievements in multi-user mode
- View other trainers' collections from the Leaderboard
- Optional public trainer profiles with trainer-name URLs, a public directory, individually shared collection binders, and opt-in market values
- Admin-controlled public sharing switch, disabled by default on new and upgraded installations
- Community section in Settings with GitHub contributors and PokéCollector supporters

### 🎨 UX & Localization
- Compact portal navigation with 6 primary home items and grouped tab navigation
- App UI translations for all supported TCGdex languages, plus Swedish
- 9 Pokemon-type color themes: Default, Fire, Water, Grass, Electric, Psychic, Dragon, Dark, Fairy

### ⚙️ Utilities
- CSV and PDF export
- Strict CSV collection import with a downloadable template; required row values are `set_code` and `number`, while `quantity`, `condition`, `variant`, `lang`, and `purchase_price` may be blank
- Admin-only sync endpoints and scheduler controls
- Backup and restore, including selective backup groups for collection, users, cards, products, system data, and images
- Backend image proxy/cache for cards and sets

### CSV Collection Import

The Collection page includes an **Import CSV** action and a downloadable template. CSV imports are intentionally strict: the header must be exactly:

```csv
set_code,number,quantity,condition,variant,lang,purchase_price
```

All columns must be present, but only `set_code` and `number` need values in each row. Use the card code shown in PokéCollector/card lists, for example `ASC 152`: `ASC` goes into `set_code`, and `152` goes into `number`.

| Column | Required value? | Notes |
| --- | --- | --- |
| `set_code` | Yes | First part of the card code shown in the app, e.g. `ASC` from `ASC 152`. |
| `number` | Yes | Second part of the card code shown in the app, e.g. `152` from `ASC 152`. |
| `quantity` | No | Defaults to `1`; must be `1`-`999` when provided. |
| `condition` | No | Defaults to `NM`; allowed: `Mint`, `NM`, `LP`, `MP`, `HP`. |
| `variant` | No | Leave blank or use `Normal`, `Holo`, `Reverse Holo`, `First Edition`. |
| `lang` | No | Defaults to `en`; accepts any supported TCGdex language code. |
| `purchase_price` | No | Optional per-card purchase price. |

Example:

```csv
set_code,number,quantity,condition,variant,lang,purchase_price
ASC,152,2,NM,,en,
PFL,001,1,LP,Reverse Holo,de,1.25
```

If any row contains a wrong value or an unknown card code, the import does not add any cards. The response shows the affected row number, so the CSV can be corrected and uploaded again.

---

## 🚀 Quick Start

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/)

### 1. Clone & Configure

```bash
git clone https://github.com/Git-Romer/pokecollector.git
cd pokecollector
```

Create a `.env` file in the project root:

```env
POSTGRES_PASSWORD=your_secure_password
JWT_SECRET_KEY=some_long_random_string

# Optional
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_admin_password
GEMINI_API_KEY=your_gemini_key
GEMINI_MODEL=gemini-flash-latest
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TCGDEX_SYNC_LANGUAGES=en,de
PUBLIC_MODE=false
CORS_ORIGINS=https://yourdomain.com
```

### 2. Start

```bash
mkdir -p data/pokedex-images backups
docker compose up -d
```

### 3. Open

| Service | URL |
|---------|-----|
| App | http://localhost:3000 |
| API docs | http://localhost:8000/docs |

### 4. First Sync

On first launch, trigger a sync from the app to populate sets and cards from TCGdex.

After upgrading an existing catalogue, the backend automatically runs the one-time Pokédex metadata backfill in the background and records completion in the database. If you need to retry or inspect it manually, run:

```bash
docker compose exec backend python -m scripts.backfill_pokedex_metadata --limit 5000
```

Repeat the metadata command until `attempted` is `0`. You can optionally pre-cache all species images:

```bash
docker compose exec backend python -m scripts.cache_pokedex_images
```

See [National Pokédex documentation](docs/POKEDEX.md) for the data model, routes, cache behavior, and Cardmarket links.

For scanner keys, hosted OpenAI, Ollama, and other compatible vision servers, see the [scanner provider setup guide](docs/scanner-providers.md).

### 5. Login

- In single-user mode, login is skipped and the app auto-authenticates as admin
- In multi-user mode, use the admin account created from `ADMIN_USERNAME` / `ADMIN_PASSWORD`
- If `ADMIN_PASSWORD` is omitted, a random password may be logged during bootstrap

> [!WARNING]
> Single-user mode has no authentication: every client that can reach the app is treated as the administrator. Use it only on a trusted local network. Do not expose a single-user installation to the internet; enable multi-user mode and protect public deployments with HTTPS and an appropriately configured reverse proxy.

---

## 🔐 Reverse Proxy Authentication

If PokéCollector is protected by Authentik, Authelia, oauth2-proxy, or another forward-auth layer, the proxy checks requests before they reach PokéCollector. Enabling public profiles inside the app is therefore not enough on its own. The proxy must also allow the public pages, their public API calls, and the assets those pages use.

See [Reverse proxy authentication](docs/REVERSE_PROXY_AUTH.md) for the complete route list, Authentik examples, and a verification checklist. Do not bypass authentication for all `/api` routes.

---

## 👥 Managing Users

User management is available from the app UI when multi-user mode is enabled.

1. Log in as an admin user.
2. Go to **Settings**.
3. Enable **Multi-User Mode** if it is not enabled yet.
4. Open the **Users** tab in Settings.

From the **Users** tab, admins can:

- add new users
- edit existing users
- change user roles between `admin` and `trainer`
- activate or deactivate users
- delete other users
- force new users to change their password on first login

The **Users** tab is only visible to admin users and only while multi-user mode is enabled. In single-user mode, PokéCollector skips login and uses the bootstrap admin account automatically.

### Enabling multi-user mode without locking yourself out

Turning on multi-user mode enforces the login screen immediately and signs you out, and you then sign back in as the bootstrap admin. In single-user mode you never had to enter that password, so if you did not set `ADMIN_PASSWORD` it is the random one from the first-run log and you may not know it. Set a known password **before** enabling multi-user mode. From the host:

```bash
# Docker
docker compose exec backend python -m scripts.set_admin_password
# Native install (run in the backend virtualenv, from the backend working directory)
python -m scripts.set_admin_password
```

The script prompts for the new password (add `--username <name>` for a non-default admin, or `--make-admin` if the only admin was demoted).

### Recovering from a lockout

If you are already locked out of multi-user mode, set `USER_MODE=single` in the environment and restart. That pins single-user mode and disables the login screen regardless of the stored setting, so you regain local admin access; reset the password with the script above, then remove the variable and restart to return to multi-user mode. While `USER_MODE` is set, the Multi-User Mode toggle in Settings is disabled and shows that the environment controls it. Because `USER_MODE=single` disables the login screen, treat it as a local/LAN recovery tool and do not leave it set on an internet-facing install. (`USER_MODE=multi` pins multi-user mode instead, which is safe to leave set.)

---

## 🔧 Environment Variables

### Required

| Variable | Description | Default |
|----------|-------------|---------|
| `POSTGRES_PASSWORD` | PostgreSQL database password | `changeme` |

### Recommended

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET_KEY` | Secret that signs login tokens. Anyone who knows it can forge a session for any account, including admin, so treat it as sensitive. Leave it unset to have a strong key generated and persisted automatically (under `data/auth/`); set it only if you want to control the value or share it across replicas. An empty value is ignored rather than used. | Generated and persisted |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `ADMIN_USERNAME` | Username for the bootstrap admin account | `admin` |
| `ADMIN_PASSWORD` | Password for the bootstrap admin account | Random, optionally logged |
| `GEMINI_API_KEY` | Initial Gemini key for the admin user; other users configure their own key in Settings | *(empty)* |
| `GEMINI_MODEL` | Gemini model used by the card scanner. Change this if Google retires the default model for new API keys. | `gemini-flash-latest` |
| `OPENAI_SCANNER_ENABLED` | Exposes the OpenAI-compatible provider in Scanner Settings. It stays hidden until deliberately enabled by an administrator. | `false` |
| `OPENAI_PROVIDER_LABEL` | Friendly name shown in Scanner Settings, for example `Local Ollama`. | `OpenAI` for the hosted API; `OpenAI-compatible` for a custom endpoint |
| `OPENAI_BASE_URL` | OpenAI-compatible endpoint for the card scanner. Point it at a local server such as Ollama, llama.cpp or LM Studio (for example `http://host.docker.internal:11434/v1` when the model runs on the Docker host, or `http://127.0.0.1:11434/v1` for a non-container install). Deliberately an administrator setting: a user-supplied backend URL would let any account direct the server at an arbitrary host. On Linux, the model service must listen on an address reachable from Docker (for example `0.0.0.0:11434`, restricted with the host firewall); listening only on `127.0.0.1` is not reachable through `host.docker.internal`. | `https://api.openai.com/v1` |
| `OPENAI_MODEL` | Installation-default OpenAI-compatible vision model. | `gpt-5.6-luna` |
| `OPENAI_ALLOWED_MODELS` | Comma-separated administrator allowlist shown as a guarded dropdown. The installation default is always included. | `OPENAI_MODEL` only |
| `OPENAI_API_KEY_REQUIRED` | Explicitly require or omit a per-user key. If unset, hosted OpenAI requires a key and custom endpoints do not. | *(automatic)* |
| `GEMINI_ALLOWED_MODELS` | Comma-separated administrator allowlist shown as a guarded dropdown. | `GEMINI_MODEL` only |
| `SCAN_TRACE_DIR` | Enables consent-controlled scanner diagnostics when set to a writable container path. With the standard compose volume, use `/app/data/scan-traces`. Each user must still opt in separately in Settings. | *(empty / disabled)* |
| `SCAN_TRACE_STORAGE_DIR` | Stable cleanup path for previously stored scanner diagnostics. Standard Docker Compose sets this to `/app/data/scan-traces`; custom deployments should keep it pointed at the storage location even when `SCAN_TRACE_DIR` is unset. | `/app/data/scan-traces` with Docker Compose |
| `TELEGRAM_BOT_TOKEN` | Initial Telegram bot token for the admin user | *(empty)* |
| `TELEGRAM_CHAT_ID` | Initial Telegram chat ID for the admin user | *(empty)* |
| `TCGDEX_SYNC_LANGUAGES` | Initial admin default for TCGdex set/card sync languages on first launch only. After bootstrap, the DB setting in Settings is authoritative. Comma-separated TCGdex language codes, or `all` to enable every supported TCGdex language. Empty or invalid values safely fall back to `en,de`. Extra languages increase sync time, API calls, and database size. | `en,de` |
| `ADMIN_BOOTSTRAP_LOG` | Whether bootstrap credentials may be logged on first start | `true` |
| `USER_MODE` | Pin the mode from the environment, overriding the stored setting and disabling the in-app toggle. `single` forces single-user (no login screen) and is the recovery hatch after a multi-user lockout; `multi` forces multi-user. Because `single` disables authentication, use it only on a local/LAN install and unset it once recovered. Unset means the in-app setting controls the mode. | *(unset)* |
| `PUBLIC_MODE` | Enable SEO meta tags, Open Graph, and allow search engine indexing. Default blocks all crawlers. Requires rebuild. | `false` |
| `CORS_ORIGINS` | Comma-separated list of allowed origins for CORS. If empty, allows all origins. Set to your domain for production (e.g. `https://pokecollector.romerg.de`). | *(all)* |
| `POKEDEX_METADATA_BACKFILL_ON_STARTUP` | Run the one-time Pokédex metadata backfill automatically after startup when existing card rows are missing `dex_ids` or Cardmarket product metadata | `true` |
| `POKEDEX_METADATA_BACKFILL_BATCH_LIMIT` | Number of cards selected per automatic Pokédex metadata backfill batch | `5000` |
| `POKEDEX_METADATA_BACKFILL_BATCH_DELAY_SECONDS` | Pause between automatic Pokédex metadata backfill batches to avoid a tight TCGdex request loop | `0.5` |
| `PRE_UPGRADE_BACKUP_ENABLED` | Create an automatic SQL backup before startup migrations when an existing install starts on a new app version | `true` |
| `PRE_UPGRADE_BACKUP_REQUIRED` | Stop startup if the automatic pre-upgrade backup fails. Set to `false` only if you have another verified backup process. | `true` |
| `PRE_UPGRADE_BACKUP_KEEP` | Number of automatic pre-upgrade backups to retain in `/app/backups`; minimum `1` | `10` |

The scanner provider variables are explained with copy-paste examples, user instructions, compatibility requirements, privacy notes, and troubleshooting in [docs/scanner-providers.md](docs/scanner-providers.md).
Administrators can also test an administrator-only custom model in Scanner Settings. A model that passes the multi-image capability check uses automatic visual verification. If it can inspect one image but cannot compare multiple images, an administrator may explicitly acknowledge and save a limited mode with visual verification disabled; the scanner displays a persistent warning while that mode is active.

Supported `TCGDEX_SYNC_LANGUAGES` codes: `en`, `fr`, `es`, `es-mx`, `it`, `pt`, `pt-br`, `pt-pt`, `de`, `nl`, `pl`, `ru`, `ja`, `ko`, `zh-tw`, `id`, `th`, `zh-cn`. The env value `all` expands to the full supported language list during first bootstrap.

### Optional scanner diagnostics

Scanner diagnostics require both server and user consent:

1. The administrator sets `SCAN_TRACE_DIR=/app/data/scan-traces` and restarts the backend.
2. A user enables **Settings → AI / Card Scanner → Share scanner diagnostics**. The toggle is off by default for every user.

Only that user's subsequent scan attempts are stored. Each trace contains the sanitized card photo, the generic prompt and raw text response from whichever provider ran the scan, parsed fields and token usage, TCGdex searches, ranked candidates, pHash/visual decisions, and errors. API keys and authentication credentials are never recorded.

Turning the toggle off stops future collection but deliberately retains existing diagnostics. There is no automatic expiry: files remain until the user presses the adjacent **Delete data** button or the account is deleted. Both actions remove only that user's stored trace JSON and photos. The stable `SCAN_TRACE_STORAGE_DIR` cleanup path keeps deletion available even while new collection is disabled. Files are created with private `0700` directory and `0600` file permissions and are not part of SQL backups.

To analyse consented traces inside the backend container:

```bash
docker compose exec backend python scripts/analyse_scan_traces.py /app/data/scan-traces --field-nulls --failures
```

English is used as the preferred fallback source for missing synced data, images, and prices when the same TCGdex card or set ID exists in English. Regional-only cards that do not exist in English are kept in their native language data instead of being guessed by name.

For Pokédex metadata only, full Pokémon card details can infer a missing TCGdex `dexId` from an exact English or German base species name. This covers cards like Mega Charizard / Mega-Glurak when TCGdex omits `dexId`, while avoiding non-Pokémon cards and unclear names.

The app UI language selector includes the supported TCGdex language set plus Swedish. The TCGdex sync-language selector controls card/set data sync only; changing the app UI language does not automatically sync additional card languages.

---

## 🔄 Sync Behavior

PokéCollector has separate sync paths so frequent price updates stay lightweight while catalogue updates remain controlled.

| Sync | Where it runs | What it updates | Limits and schedule |
|------|---------------|-----------------|---------------------|
| Small price sync | Home sync button and automatic price job | Prices for tracked cards in collections, wishlists, and binders | Runs every `30` minutes by default. Updates `max(1000, 75% of tracked unique cards)`, capped at `5000` cards per run. Missing-price cards are prioritized, but cards without public prices have a retry cooldown. |
| Forced price sync | Settings `Sync prices only` action | Prices for all tracked collection, wishlist, and binder cards | Runs on demand. It is not capped like the small automatic batch and bypasses the no-price retry cooldown. It does not sync sets, discover new cards, or refresh card images. |
| Full sync | Settings `Sync sets/cards` action and automatic full sync job | TCGdex set metadata, card lists, missing card details, tracked-card prices, pinned-set prices, custom-card matches, portfolio snapshots, and wishlist alerts | Runs every `5` days by default. The admin setting can change this to `1`, `2`, `3`, `5`, `7`, `14`, or `30` days. |

Full sync keeps heavier catalogue work bounded:

- incomplete sets and fallback-language sets have their card lists refreshed every full sync
- already-complete native sets are refreshed in a rotating batch of `25` sets per full sync, ordered by oldest set refresh time first
- missing full-card metadata enrichment is capped separately at `2000` cards per full sync
- normal price sync limits do not increase the full-card metadata cap

With the default `en,de` sync languages, the rotating complete-set refresh covers the current catalogue in roughly `70` days at the default `5` day full-sync interval. Manual full syncs also advance the rotation.

---

## 🏗️ Architecture

```text
pokecollector/
├── backend/         # FastAPI + SQLAlchemy + PostgreSQL
│   ├── api/         # Feature routers
│   ├── services/    # Auth, sync, scheduler, Telegram, TCGdex integration
│   ├── models.py    # ORM models
│   ├── schemas.py   # Pydantic schemas
│   └── database.py  # DB init and idempotent migrations
├── frontend/        # React 18 + Vite + Tailwind CSS
│   └── src/
│       ├── pages/
│       ├── components/
│       ├── contexts/
│       ├── hooks/
│       ├── i18n/
│       └── api/
└── docker-compose.yml
```

The old nested `pokemon-tcg-collection/` layout is no longer used.

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, Tailwind CSS, TanStack Query |
| Backend | Python 3.11, FastAPI, SQLAlchemy, APScheduler, Pydantic |
| Database | PostgreSQL 18 |
| Card Data | [TCGdex](https://tcgdex.dev/) |
| AI Scanner | Google Gemini (default) or an administrator-enabled OpenAI-compatible vision endpoint, including local Ollama, llama.cpp and LM Studio. Users only choose from approved providers and models; prompts and the scanner workflow stay provider-neutral. |
| Deploy | Docker + Docker Compose |

---

## 🌐 External Sources

PokéCollector is self-hosted, but it can call these external sources depending on enabled features and user actions:

| Source | Host(s) | Used for | When it is called |
|--------|---------|----------|-------------------|
| TCGdex | `api.tcgdex.net`, `assets.tcgdex.net` | Set/card catalogue data, images, prices, localized card metadata, Pokédex `dexId`, and Cardmarket product metadata | Initial sync, manual/admin sync, search fallbacks, metadata backfills, and card image display |
| PokeAPI sprites | `raw.githubusercontent.com/PokeAPI/sprites` | Profile/avatar GIFs, achievement badges, binder icons, National Pokédex sprites, and official artwork cache | Browser image display, Pokédex image cache misses, and `scripts.cache_pokedex_images` |
| Google Gemini | `generativelanguage.googleapis.com` | AI card scanner recognition | Only when scanner recognition is used and `GEMINI_API_KEY` is configured |
| OpenAI-compatible endpoint | `OPENAI_BASE_URL`, by default `api.openai.com` | AI card scanner recognition | Only after an administrator enables the provider and a user selects it. Card photos are sent to the configured endpoint, which may be a server on your own network. |
| Telegram Bot API | `api.telegram.org` | Telegram notifications and alerts | Only when Telegram settings are configured and an alert/notification is sent |
| Frankfurter | `api.frankfurter.dev` | Currency exchange rates | Currency conversion and Telegram price formatting when non-EUR values are needed |
| PokéCollector supporter registry | `pokecollector.romerg.de` | Strictly limited public supporter names, profile links, crowns, and aggregated support details | The self-hosted backend fetches the public registry when the Settings Community view is opened; there is no recurring polling |
| GitHub | `api.github.com`, `raw.githubusercontent.com`, `avatars.githubusercontent.com`, `github.com` | Community contributor data, historic rescue-donation data, GitHub avatars, project links, and release/source links | Settings community section and linked project metadata |
| Betterplace | `www.betterplace.org` | Direct animal-rescue donation campaign | Browser opens the outbound campaign link only; self-hosted instances do not call the Betterplace API |
| Cardmarket | `www.cardmarket.com` | Product/search links for cards | Browser opens outbound links only; PokéCollector does not call a Cardmarket API |

Build and dependency installation also contact package/distribution registries such as npm and the PostgreSQL apt repository when Docker images are built.

---

## 📚 Documentation

| Doc | Description |
|-----|-------------|
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contributor workflow and shared card-interface guidance |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System structure, data flow, contexts, settings model |
| [`docs/BACKEND.md`](docs/BACKEND.md) | API routes, models, settings scoping, backup behavior |
| [`docs/FRONTEND.md`](docs/FRONTEND.md) | Routes, pages, components, contexts, theming, i18n |
| [`docs/CARD_SYSTEM.md`](docs/CARD_SYSTEM.md) | Public card components, variants, gallery, and extension workflow |
| [`docs/REVERSE_PROXY_AUTH.md`](docs/REVERSE_PROXY_AUTH.md) | Forward-auth exceptions for public profiles and binders |

---

## 🔧 Configuration Reference

All settings are persisted in the database and edited in the Settings UI.

| Setting | Default | Notes |
|---------|---------|-------|
| Language | `en` | App UI language. Options include `en`, `fr`, `es`, `es-mx`, `it`, `pt`, `pt-br`, `pt-pt`, `de`, `nl`, `pl`, `ru`, `ja`, `ko`, `zh-tw`, `id`, `th`, `zh-cn`, and `sv`. |
| Currency | `EUR` | Per-user |
| Primary Price | `trend` | Per-user. Options: `trend`, `avg`, `avg1`, `avg7`, `avg30`, `low` |
| Multi-User Mode | `false` | Admin-only toggle |
| TCGdex Sync Languages | `en,de` | Admin-only. Controls which TCGdex set/card languages full sync fetches. Extra languages increase sync time, API calls, and database size. |
| Cross-language Price Fallback | `true` | Admin-only. Uses English exact-ID price data when the selected card language has no native public price data. |
| Cross-language Image Fallback | `true` | Admin-only. Uses English exact-ID images when the selected card language has no native public image data. |
| Debug Mode | `false` | Admin-only. Enables downloadable backend debug logging. |
| Theme | `default` | Stored in browser local storage |
| Price Sync Interval | `30` minutes | Admin-only |
| Full Sync Interval | `5` days | Admin-only |

### Cardmarket price fields

Card prices come from the TCGdex API's Cardmarket price data and are stored in EUR. The selected primary price controls collection totals, dashboard values, analytics, binders, social stats, exports, and alerts. Currency conversion is display-only when USD is selected.

| Option | Cardmarket field | Meaning |
|--------|------------------|---------|
| Trend | `trend` / `trend-holo` | Cardmarket trend price; closest available field to a current market value, but still an aggregated API value, not a live listing price. |
| Average | `avg` / `avg-holo` | Cardmarket average sell price. This is stable and close to the historical app behavior. |
| Avg 1 Day | `avg1` / `avg1-holo` | Average over the last day; very recent, but can be noisy when few sales exist. |
| Avg 7 Days | `avg7` / `avg7-holo` | Average over the last seven days; smoother recent value. |
| Avg 30 Days | `avg30` / `avg30-holo` | Average over the last 30 days; stable, slower to react. |
| Low | `low` / `low-holo` | Lowest Cardmarket price; useful as a conservative value, often below realistic collection value. |

For holo and reverse-holo collection items, PokéCollector uses the matching `*-holo` field when available. If TCGdex reports a holo price as `0` or missing, PokéCollector treats it as unavailable and falls back to the selected non-holo Cardmarket field, then to the Cardmarket average, instead of valuing the card at €0.

---

## 🔄 Updating

PokéCollector has a built-in upgrade safety layer for existing installs: before startup migrations run on a new app version, the backend creates an automatic SQL backup in `./backups` by default. Startup stops if that automatic backup fails, unless you explicitly disable the requirement with `PRE_UPGRADE_BACKUP_REQUIRED=false`.

This automatic backup is still only a safety net. Keep creating your own manual backup before updates, especially before database major-version upgrades.

### PostgreSQL 18 upgrade

PokéCollector now uses PostgreSQL 18 for Docker installs. Existing Docker installs that still have a PostgreSQL 15 data volume must run the one-time upgrade script before recreating the database container with PostgreSQL 18. PostgreSQL cannot upgrade a major-version data directory just by changing the Docker image.

You do not need to install every intermediate PokéCollector app version first. Upgrade from your current PostgreSQL 15 install directly to this release: the script handles the database engine major-version upgrade, then the backend applies the app's cumulative startup migrations. Older installs that predate the recorded app-version setting are still treated as existing installs and backed up before those app migrations run.

Create or verify a manual backup first while your current PostgreSQL 15 stack is still running:

```bash
docker compose exec postgres pg_dump -U pokemon pokemon_tcg > backup_$(date +%Y%m%d).sql
```

Then pull the updated project files, but do not run the normal `docker compose up -d --build` command yet. Also do not run `docker compose down -v` or remove Docker volumes before the upgrade script finishes; that deletes the old database volume and leaves only your manual backup as the recovery path.

```bash
git pull
./scripts/upgrade-postgres-15-to-18.sh
```

The script stops the app services to prevent writes during the dump, creates a SQL dump from PostgreSQL 15, keeps a rollback copy of the old PostgreSQL 15 Docker volume, initializes a fresh PostgreSQL 18 volume using the PostgreSQL 18 Docker image layout, restores the dump, and rebuilds/starts the stack again. It asks for confirmation before changing volumes.

After the script restores PostgreSQL 18 and starts the app, the existing automatic pre-upgrade backup still runs before app startup migrations when the app version changes. That automatic backup is an extra safety net; the PostgreSQL 15 dump created by the script is the database major-version upgrade backup.

If you accidentally run `docker compose up -d --build` before the script, the PostgreSQL 18 container refuses to start when it detects old PostgreSQL data in the existing volume. Do not delete the volume. Run `./scripts/upgrade-postgres-15-to-18.sh`; if the original PostgreSQL 15 container was already stopped, the script can dump from the existing volume through a temporary PostgreSQL 15 container.

Fresh installs do not need this step. Existing installs only use the normal app update command below after this one-time PostgreSQL upgrade has completed.

### App updates

PokéCollector creates an automatic SQL backup before startup migrations when an existing install starts on a new app version. This safety backup is there in case something goes wrong during an update or a migration breaks after a version change.

Automatic backups are stored in the mounted backups folder:

```text
./backups/pre_upgrade_<old-version>_to_<new-version>_<timestamp>.sql
```

By default, startup stops if this safety backup fails. This protects existing card collections before version migrations run.

> **Important:** Always create your own manual backup before updating the application. The automatic pre-upgrade backup is an extra safety net, not a replacement for a verified backup you control.

```bash
docker compose exec postgres pg_dump -U pokemon pokemon_tcg > backup_$(date +%Y%m%d).sql
```

Then update:

```bash
git pull
docker compose up -d --build
```

Database migrations run automatically on startup after the pre-upgrade backup succeeds. If you need to roll back, stop the app, switch back to the previous app version, and restore the matching SQL backup.

---

## 🌱 Community Projects

PokéCollector is not only about the app itself. It is also about the ways collectors organize and use their collections in real life.

Big shoutout to [f0rr3stfunk](https://github.com/f0rr3stfunk) for detailed testing, bug reports, feedback, and for sharing a very cool storage box divider project for Pokémon card sets.

The dividers include set logos and space for NFC tags, so tapping a divider with a phone can open the matching set overview in PokéCollector.

Makerworld project:
https://makerworld.com/de/models/2816777-high-dividers-with-set-logo-nfc-tag#profileId-3136169

---

## ❤️ Support

If you want to support PokéCollector, you can donate directly to animal rescue through the official campaign:

https://pokecollector.romerg.de/#support

Betterplace processes the donation and forwards it to the selected animal rescue project. PokéCollector never receives the funds.

To appear in the public supporter list, donate non-anonymously and begin the public Betterplace message with `POKECOLLECTOR: Your desired name`. The website's support section also includes a no-login manual review form. Published names can be corrected or removed by contacting [info@romerg.de](mailto:info@romerg.de).

Approved supporter information is held in a private registry on the PokéCollector website server. It publishes only the versioned public projection at `https://pokecollector.romerg.de/api/v1/supporters`; pending entries, provider identifiers, suppression records, private request data, databases, and backups are never exposed. Each self-hosted PokéCollector backend validates that projection before returning it to its own browser. It keeps no persistent supporter cache and shows a temporary unavailable state instead of stale or GitHub-hosted data whenever the registry cannot be validated.

<!-- rescue-donation-total:start -->
**Historic animal-rescue donations forwarded before Betterplace:** €0.00
<!-- rescue-donation-total:end -->

Historic transfers made before the direct Betterplace campaign remain tracked in `RESCUE_DONATIONS.csv`. After updating that CSV, run `node scripts/update-rescue-donation-total.mjs` to refresh this README total.

---

## 📝 License

[GNU AGPLv3](LICENSE)
