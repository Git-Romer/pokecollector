# ⚠️ Disclaimer
Everything below (and in this repo) is unapologetically vibecoded.
Expect vibes, not guarantees. Proceed with good humor and version control.

Contributions are welcome. Open a pull request for fixes, features, or docs. Not sure where to start? Open an issue and we'll chat. Small improvements are great.

Found a bug or have an idea? Open an issue. Include steps to reproduce, expected vs. actual behavior. Screenshots or logs help.

Fork, branch, and submit a focused PR. Add or update tests and docs as needed. Explain the "why" and link related issues. Make sure checks pass.

Be kind. Be clear. Assume good intent. Keep feedback constructive.

# 🃏 PokéCollector

> A self-hosted, full-stack Pokémon TCG collection manager for cards, sealed products, binders, analytics, scanning, and multi-user collections.

🌐 **Website:** [pokecollector.romerg.de](https://pokecollector.romerg.de/)

![Version](https://img.shields.io/badge/version-v1.19.0-e3000b?style=flat-square) ![Dark Theme](https://img.shields.io/badge/theme-dark-1a1a2e?style=flat-square) ![TCGdex](https://img.shields.io/badge/card%20data-TCGdex-e3000b?style=flat-square) ![Docker](https://img.shields.io/badge/deploy-Docker-2496ed?style=flat-square) ![FastAPI](https://img.shields.io/badge/backend-FastAPI-009688?style=flat-square) ![React](https://img.shields.io/badge/frontend-React%2018-61dafb?style=flat-square) [![Ko-fi](https://img.shields.io/badge/support-Ko--fi-ff5e5b?style=flat-square&logo=ko-fi&logoColor=white)](https://ko-fi.com/gillesromer)

**Current version:** `v1.19.0` · Releases are tracked on the [GitHub Releases page](https://github.com/Git-Romer/pokecollector/releases).

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
- Track German, English, and Chinese cards separately
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
- German, English, and Chinese UI
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
| `lang` | No | Defaults to `en`; allowed: `en`, `de`. |
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
| `TCGDEX_SYNC_LANGUAGES` | Initial admin default for TCGdex set/card sync languages on first launch only. After bootstrap, the DB setting in Settings is authoritative. Allowed values: `en`, `de`, `en,de` | `en,de` |
| `ADMIN_BOOTSTRAP_LOG` | Whether bootstrap credentials may be logged on first start | `true` |
| `PUBLIC_MODE` | Enable SEO meta tags, Open Graph, and allow search engine indexing. Default blocks all crawlers. Requires rebuild. | `false` |
| `CORS_ORIGINS` | Comma-separated list of allowed origins for CORS. If empty, allows all origins. Set to your domain for production (e.g. `https://pokecollector.romerg.de`). | *(all)* |
| `PRE_UPGRADE_BACKUP_ENABLED` | Create an automatic SQL backup before startup migrations when an existing install starts on a new app version | `true` |
| `PRE_UPGRADE_BACKUP_REQUIRED` | Stop startup if the automatic pre-upgrade backup fails. Set to `false` only if you have another verified backup process. | `true` |
| `PRE_UPGRADE_BACKUP_KEEP` | Number of automatic pre-upgrade backups to retain in `/app/backups`; minimum `1` | `10` |

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
| Database | PostgreSQL 15 |
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
| Language | `de` | `de`, `en`, `zh` |
| Currency | `EUR` | Per-user |
| Primary Price | `trend` | Per-user |
| Multi-User Mode | `false` | Admin-only toggle |
| Theme | `default` | Stored in browser local storage |
| Price Sync Interval | `30` minutes | Admin-only |
| Full Sync Interval | `5` days | Admin-only |

---

## 🔄 Updating

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

---

## 📝 License

[GNU AGPLv3](LICENSE)
