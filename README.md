# ⚠️ Disclaimer
Everything below (and in this repo) is unapologetically vibecoded.
Expect vibes, not guarantees. Proceed with good humor and version control.

Contributions are welcome. Open a pull request for fixes, features, or docs. Not sure where to start? Open an issue and we'll chat. Small improvements are great.

Found a bug or have an idea? Open an issue. Include steps to reproduce, expected vs. actual behavior. Screenshots or logs help.

Fork, branch, and submit a focused PR. Add or update tests and docs as needed. Explain the "why" and link related issues. Make sure checks pass.

Be kind. Be clear. Assume good intent. Keep feedback constructive.

# 🃏 PokéCollector

> A self-hosted, full-stack Pokémon TCG collection manager for cards, sealed products, binders, analytics, scanning, and multi-user collections.

![Dark Theme](https://img.shields.io/badge/theme-dark-1a1a2e?style=flat-square) ![TCGdex](https://img.shields.io/badge/card%20data-TCGdex-e3000b?style=flat-square) ![Docker](https://img.shields.io/badge/deploy-Docker-2496ed?style=flat-square) ![FastAPI](https://img.shields.io/badge/backend-FastAPI-009688?style=flat-square) ![React](https://img.shields.io/badge/frontend-React%2018-61dafb?style=flat-square) [![Ko-fi](https://img.shields.io/badge/support-Ko--fi-ff5e5b?style=flat-square&logo=ko-fi&logoColor=white)](https://ko-fi.com/gillesromer)

![WebApp Preview](preview-homescreen.png)

---

## 📑 Table of Contents

- [Features](#-features)
- [Quick Start](#-quick-start)
- [Environment Variables](#-environment-variables)
- [Architecture](#-architecture)
- [Tech Stack](#-tech-stack)
- [Documentation](#-documentation)
- [Configuration Reference](#-configuration-reference)
- [Updating](#-updating)
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
- Smart scanner with Gemini-powered recognition
- Two-step scanner matching: number ranking first, visual verification second
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
- Community section in Settings with GitHub contributors and Ko-fi supporters

### 🎨 UX & Localization
- Compact portal navigation with 6 primary home items and grouped tab navigation
- German, English, and Chinese UI
- 9 Pokemon-type color themes: Default, Fire, Water, Grass, Electric, Psychic, Dragon, Dark, Fairy

### ⚙️ Utilities
- CSV and PDF export
- Admin-only sync endpoints and scheduler controls
- Backup and restore, including selective backup groups for collection, users, cards, products, system data, and images
- Backend image proxy/cache for cards and sets

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
PUBLIC_MODE=false
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
| `ADMIN_BOOTSTRAP_LOG` | Whether bootstrap credentials may be logged on first start | `true` |
| `PUBLIC_MODE` | Enable SEO meta tags, Open Graph, and allow search engine indexing. Default blocks all crawlers. Requires rebuild. | `false` |

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

Back up the database before updating:

```bash
docker compose exec postgres pg_dump -U pokemon pokemon_tcg > backup_$(date +%Y%m%d).sql
```

Then update:

```bash
git pull
docker compose up -d --build
```

Database migrations run automatically on startup.

---

## ❤️ Support

If you want to support the project, use Ko-fi:

https://ko-fi.com/gillesromer

Supporters listed through Ko-fi can appear in the in-app Community section.

---

## 📝 License

[GNU AGPLv3](LICENSE)
