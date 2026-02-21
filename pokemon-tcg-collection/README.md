# Pokemon TCG Collection Manager

A full-stack web application for managing your Pokemon Trading Card Game collection.

## Features

- 🔍 **Card Search** — Search by name, set, type, rarity via TCGdex API (api.tcgdex.net)
- 📚 **Collection Management** — Track cards with quantity, condition (Mint/NM/LP/MP/HP), purchase price
- 🗂️ **Set Checklist** — Visual grid per set, green=owned/red=missing, progress bars
- 📈 **Price History** — Cardmarket EUR prices stored daily, line charts per card
- 🔄 **Auto Sync** — Background sync every 30 min (no API key required)
- 💚 **Wishlist** — Price alerts with Telegram notifications
- 📖 **Binders** — Virtual binders/folders to organize cards
- 📊 **Dashboard** — Portfolio value, top cards, value over time
- 📉 **Analytics** — Duplicates, top movers, rarity stats, investment tracker
- 📦 **Products** — Sealed product P&L broker dashboard
- 📤 **Export** — CSV and PDF export
- 💾 **Backup/Restore** — Full DB dump and restore

## Quick Start

1. Copy environment file:
```bash
cp .env.example .env
```

2. Edit `.env` with your values:
```
TELEGRAM_BOT_TOKEN=your_bot_token   # optional, for price alerts
TELEGRAM_CHAT_ID=your_chat_id       # optional
POSTGRES_PASSWORD=your_secure_password
```

No API key needed — TCGdex is a free, open API.

3. Start with Docker Compose:
```bash
docker compose up -d
```

4. Open http://localhost:3000

## Architecture

- **Frontend**: React 18 + Vite + Tailwind CSS (dark mode default)
- **Backend**: Python FastAPI (port 8000)
- **Database**: PostgreSQL 15
- **Card Data**: TCGdex API (https://api.tcgdex.net/v2/en) — no API key required
- **Prices**: Cardmarket EUR prices via TCGdex pricing data
- **Sync**: APScheduler every 30 minutes

## Design

- Dark theme (#1a1a2e background, #EE1515 Pokemon Red accent)
- Minimalist, card-focused layout
- Mobile-responsive

## API Documentation

Backend API docs available at http://localhost:8000/docs

## TCGdex API

Card data is powered by [TCGdex](https://tcgdex.net/), an open-source Pokemon TCG API.
- No API key required
- Cardmarket EUR pricing included
- Card images served from assets.tcgdex.net
