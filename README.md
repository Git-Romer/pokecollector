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

![Version](https://img.shields.io/badge/version-v1.22.4-e3000b?style=flat-square) ![Dark Theme](https://img.shields.io/badge/theme-dark-1a1a2e?style=flat-square) ![TCGdex](https://img.shields.io/badge/card%20data-TCGdex-e3000b?style=flat-square) ![Docker](https://img.shields.io/badge/deploy-Docker-2496ed?style=flat-square) ![FastAPI](https://img.shields.io/badge/backend-FastAPI-009688?style=flat-square) ![React](https://img.shields.io/badge/frontend-React%2018-61dafb?style=flat-square) [![Ko-fi](https://img.shields.io/badge/support-Ko--fi-ff5e5b?style=flat-square&logo=ko-fi&logoColor=white)](https://ko-fi.com/gillesromer)

**Current version:** `v1.22.4` · Releases are tracked on the [GitHub Releases page](https://github.com/Git-Romer/pokecollector/releases).

![WebApp Preview](preview-homescreen.png)

---

## 📑 Table of Contents

- [Features](#-features)
- [Quick Start](#-quick-start)
- [Managing Users](#-managing-users)
- [Environment Variables](#-environment-variables)
- [Architecture](#-architecture)
- [Tech Stack](#-tech-stack)
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
- Manually create custom cards not present in TCGdex

### 🔍 Search & Scanning
- Search the locally cached card database by name, set, type, rarity, HP, artist, and more
- Short-code search like `PFL 001`
- Multi-select search results and bulk-add matching cards to the collection
- Smart scanner with Gemini-powered recognition
- Scanner retries transient Gemini capacity errors and shows clearer rate-limit / temporary-unavailable messages
- Two-step scanner matching: number ranking first, visual verification second when useful
- Scanner strips suffixes like `ex` / `GX` / `VSTAR` for broader matching
- Card modal auto-preselects a likely variant from TCGdex variant flags

### 🗂️ Sets, Binders & Wishlist
- Set overview with completion progress and per-set checklist
- Virtual binders for collection and checklist views
- Wishlist with Telegram price alerts

### 📈 Prices, Portfolio & Analytics
- Cardmarket EUR pricing and TCGPlayer USD pricing via TCGdex
- Price history charts and portfolio snapshots
- Dashboard, duplicates, top movers, rarity stats, and investment tracker
- Sealed product tracking with realized and unrealized P&L

### 👤 Single-User & Multi-User
- Single-user mode: no login required, auto-auth as admin
- Multi-user mode: JWT login, admin/trainer roles, separate user data
- Per-user settings for language, currency, Telegram keys, and Gemini key
- Force password change support on first login
- Profile avatar and profile name editing
- Cascade deletion of user-owned data

### 🏆 Social & Community
- Leaderboard, trainer comparison, and achievements in multi-user mode
- View other trainers' collections from the Leaderboard
- Community section in Settings with GitHub contributors and Ko-fi supporters

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
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TCGDEX_SYNC_LANGUAGES=en,de
PUBLIC_MODE=false
CORS_ORIGINS=https://yourdomain.com
```

### 2. Start

```bash
docker compose up -d
```

### 3. Open

| Service | URL |
|---------|-----|
| App | http://localhost:3000 |
| API docs | http://localhost:8000/docs |

### 4. First Sync

On first launch, trigger a sync from the app to populate sets and cards from TCGdex.

### 5. Login

- In single-user mode, login is skipped and the app auto-authenticates as admin
- In multi-user mode, use the admin account created from `ADMIN_USERNAME` / `ADMIN_PASSWORD`
- If `ADMIN_PASSWORD` is omitted, a random password may be logged during bootstrap

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

---

## 🔧 Environment Variables

### Required

| Variable | Description | Default |
|----------|-------------|---------|
| `POSTGRES_PASSWORD` | PostgreSQL database password | `changeme` |

### Recommended

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_SECRET_KEY` | Secret used to sign JWT tokens; without it, sessions are not stable across restarts | Random per restart |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `ADMIN_USERNAME` | Username for the bootstrap admin account | `admin` |
| `ADMIN_PASSWORD` | Password for the bootstrap admin account | Random, optionally logged |
| `GEMINI_API_KEY` | Initial Gemini key for the admin user; other users configure their own key in Settings | *(empty)* |
| `TELEGRAM_BOT_TOKEN` | Initial Telegram bot token for the admin user | *(empty)* |
| `TELEGRAM_CHAT_ID` | Initial Telegram chat ID for the admin user | *(empty)* |
| `TCGDEX_SYNC_LANGUAGES` | Initial admin default for TCGdex set/card sync languages on first launch only. After bootstrap, the DB setting in Settings is authoritative. Comma-separated TCGdex language codes, or `all` to enable every supported TCGdex language. Empty or invalid values safely fall back to `en,de`. Extra languages increase sync time, API calls, and database size. | `en,de` |
| `ADMIN_BOOTSTRAP_LOG` | Whether bootstrap credentials may be logged on first start | `true` |
| `PUBLIC_MODE` | Enable SEO meta tags, Open Graph, and allow search engine indexing. Default blocks all crawlers. Requires rebuild. | `false` |
| `CORS_ORIGINS` | Comma-separated list of allowed origins for CORS. If empty, allows all origins. Set to your domain for production (e.g. `https://pokecollector.romerg.de`). | *(all)* |
| `PRE_UPGRADE_BACKUP_ENABLED` | Create an automatic SQL backup before startup migrations when an existing install starts on a new app version | `true` |
| `PRE_UPGRADE_BACKUP_REQUIRED` | Stop startup if the automatic pre-upgrade backup fails. Set to `false` only if you have another verified backup process. | `true` |
| `PRE_UPGRADE_BACKUP_KEEP` | Number of automatic pre-upgrade backups to retain in `/app/backups`; minimum `1` | `10` |

Supported `TCGDEX_SYNC_LANGUAGES` codes: `en`, `fr`, `es`, `es-mx`, `it`, `pt`, `pt-br`, `pt-pt`, `de`, `nl`, `pl`, `ru`, `ja`, `ko`, `zh-tw`, `id`, `th`, `zh-cn`. The env value `all` expands to the full supported language list during first bootstrap.

English is used as the preferred fallback source for missing synced data, images, and prices when the same TCGdex card or set ID exists in English. Regional-only cards that do not exist in English are kept in their native language data instead of being guessed by name.

The app UI language selector includes the supported TCGdex language set plus Swedish. The TCGdex sync-language selector controls card/set data sync only; changing the app UI language does not automatically sync additional card languages.

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
| AI Scanner | Google Gemini 2.5 Flash |
| Deploy | Docker + Docker Compose |

---

## 📚 Documentation

| Doc | Description |
|-----|-------------|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System structure, data flow, contexts, settings model |
| [`docs/BACKEND.md`](docs/BACKEND.md) | API routes, models, settings scoping, backup behavior |
| [`docs/FRONTEND.md`](docs/FRONTEND.md) | Routes, pages, components, contexts, theming, i18n |

---

## 🔧 Configuration Reference

All settings are persisted in the database and edited in the Settings UI.

| Setting | Default | Notes |
|---------|---------|-------|
| Language | `de` | App UI language. Options include `en`, `fr`, `es`, `es-mx`, `it`, `pt`, `pt-br`, `pt-pt`, `de`, `nl`, `pl`, `ru`, `ja`, `ko`, `zh-tw`, `id`, `th`, `zh-cn`, and `sv`. |
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

If you want to support the project, use Ko-fi:

https://ko-fi.com/gillesromer

All donations go to an animal rescue organization. Supporters listed through Ko-fi can appear in the in-app Community section.

<!-- rescue-donation-total:start -->
**Animal rescue donations sent so far:** €0.00
<!-- rescue-donation-total:end -->

Actual transfers to rescue organizations are tracked separately from supporter tips in `RESCUE_DONATIONS.csv`, because donations are sent in batches. After updating that CSV, run `node scripts/update-rescue-donation-total.mjs` to refresh this README total.

---

## 📝 License

[GNU AGPLv3](LICENSE)
