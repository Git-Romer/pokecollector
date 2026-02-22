# ⚠️ Disclaimer
Everything below (and in this repo) is unapologetically vibecoded.
Expect vibes, not guarantees. Proceed with good humor and version control.  

Contributions are welcome. Open a pull request for fixes, features, or docs. Not sure where to start? Open an issue and we’ll chat. Small improvements are great.

Found a bug or have an idea? Open an issue. Include steps to reproduce, expected vs. actual behavior. Screenshots or logs help.

Fork, branch, and submit a focused PR. Add or update tests and docs as needed. Explain the “why” and link related issues. Make sure checks pass.

Be kind. Be clear. Assume good intent. Keep feedback constructive.

# 🃏 PokéCollector

> A self-hosted, full-stack Pokémon TCG collection management app — track your cards, monitor prices, manage binders, and analyse your portfolio.

![Dark Theme](https://img.shields.io/badge/theme-dark-1a1a2e?style=flat-square) ![TCGdex](https://img.shields.io/badge/card%20data-TCGdex-e3000b?style=flat-square) ![Docker](https://img.shields.io/badge/deploy-Docker-2496ed?style=flat-square) ![FastAPI](https://img.shields.io/badge/backend-FastAPI-009688?style=flat-square) ![React](https://img.shields.io/badge/frontend-React%2018-61dafb?style=flat-square)

![WebApp Preview](preview-homescreen.png)
---

## ✨ Features

### 📦 Collection Management
- Add cards with **quantity**, **condition** (Mint / NM / LP / MP / HP), **variant** (Holo, Reverse Holo, First Edition, Alt Art, etc.), **purchase price**, and **grade** (PSA, BGS, CGC)
- Track **German and English** card versions separately
- Manually create custom cards not in TCGdex

### 🔍 Card Search
- Search all cards cached in your local database by name, set, type, rarity, HP, artist
- Short-code search: type `PFL 001` to find card #1 from Paldea Fates directly
- Language filter: show DE only, EN only, or both
- Scan a card with your camera for AI-powered recognition (requires Google Gemini API key)

### 🗂️ Set Checklists
- Browse all Pokémon TCG sets with logo, series, total cards, and your completion %
- Per-set checklist: green = owned, red/grey = missing
- Supports both German and English set versions

### 📈 Price Tracking & Portfolio
- **Cardmarket EUR** prices (non-holo + holo variants): market, low, trend, avg1, avg7, avg30
- **TCGPlayer USD** prices: normal, reverse holo, holo market prices
- Daily price history with line charts per card
- Portfolio value over time chart on the dashboard
- Configurable **primary price** for value calculations (Settings → Primary Price)

### 📊 Analytics
- Top 10 most valuable cards in your collection
- Duplicate cards (owned > 1 copy) sorted by total value
- Top price movers in the last 1–30 days
- Rarity distribution breakdown
- Investment tracker: cost vs. current value over time

### 🛍️ Products (Sealed)
- Track sealed product purchases (booster boxes, ETBs, etc.)
- Record purchase price, current value, sold price
- Realized P&L on sold products shown on the dashboard

### 💚 Wishlist
- Save cards you want to acquire
- Set price alerts (above / below threshold) with **Telegram notifications**

### 📖 Binders
- Organise cards into virtual binders
- Collection binder type: only shows cards you own
- Checklist binder type: shows all cards, highlights owned ones

### ⚙️ Settings & Utilities
- **Language**: German / English UI
- **Primary Price**: choose which Cardmarket price drives your portfolio value
- **Currency**: EUR or USD (live exchange rate via Frankfurter API)
- **Export**: CSV or PDF of your full collection
- **Backup / Restore**: full PostgreSQL dump and restore
- **Sync**: manual trigger or automatic (configurable interval)
- **eBay graded price lookup**: search eBay sold listings for PSA/BGS/CGC graded cards

---

## 🚀 Quick Start

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/) + [Docker Compose](https://docs.docker.com/compose/)

### 1. Clone & Configure

```bash
git clone https://github.com/Git-Romer/pokecollector.git
cd pokecollector
cp .env.example .env   # create if not present
```

Edit `.env`:
```env
POSTGRES_PASSWORD=your_secure_password

# Optional — for price alert Telegram notifications
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Optional — for AI card recognition
GEMINI_API_KEY=your_gemini_key

# Optional — for eBay graded price lookup
EBAY_APP_ID=your_ebay_app_id
```

> No TCGdex API key required — it's a free open API.

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

On first launch the app is empty. Go to **Settings → Run Sync Now** (or click the 🔄 sync button on the home screen) to fetch all sets and cards from TCGdex. This takes 1–3 minutes.

---

## 🏗️ Architecture

```
pokecollector/
├── backend/         # Python FastAPI + PostgreSQL
│   ├── api/         # Route handlers (sets, cards, collection, analytics, …)
│   ├── services/    # TCGdex client, sync logic, scheduler, notifications
│   ├── models.py    # SQLAlchemy ORM
│   ├── schemas.py   # Pydantic schemas
│   └── database.py  # DB engine + idempotent migrations
├── frontend/        # React 18 + Vite + Tailwind CSS
│   └── src/
│       ├── pages/   # Route pages
│       ├── components/
│       ├── contexts/ # SettingsContext (i18n, price config, currency)
│       └── api/     # Axios client
└── docker-compose.yml
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full deep-dive.

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, Tailwind CSS, TanStack Query, Recharts, Lucide Icons |
| Backend | Python 3.11, FastAPI, SQLAlchemy, APScheduler, Pydantic |
| Database | PostgreSQL 15 |
| Card Data | [TCGdex](https://tcgdex.net/) — free, no API key |
| Prices | Cardmarket EUR + TCGPlayer USD (via TCGdex pricing) |
| Deploy | Docker + Docker Compose |

---

## 📚 Documentation

| Doc | Description |
|-----|-------------|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System architecture, data flow, ID model |
| [`docs/BACKEND.md`](docs/BACKEND.md) | API routes, models, migration guide |
| [`docs/FRONTEND.md`](docs/FRONTEND.md) | Pages, components, styling, i18n |

---

## 🔧 Configuration Reference

All settings are persisted in the database and editable via the Settings page:

| Setting | Default | Options |
|---------|---------|---------|
| Language | `de` | `de`, `en` |
| Primary Price | `trend` | `trend`, `avg1`, `avg7`, `avg30`, `low`, `market` |
| Currency | `EUR` | `EUR`, `USD` |
| Auto-sync interval | 30 min | Configurable |
| Full sync interval | 5 days | Configurable |

---

## 📝 License

[GNU AGPLv3](LICENSE)
