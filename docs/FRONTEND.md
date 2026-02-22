# Frontend Reference

React 18 SPA built with Vite. All source under `frontend/src/`.

## Pages (React Router routes)

| Route | Component | Description |
|-------|-----------|-------------|
| `/` | `HomeScreen.jsx` | Dashboard — portfolio value, chart, quick nav |
| `/collection` | `CollectionScreen.jsx` | All owned cards, filter/sort |
| `/search` | `CardSearch.jsx` | Search all known cards, add to collection |
| `/sets` | `SetsScreen.jsx` | Browse all sets with completion progress |
| `/sets/:id` | `SetChecklist.jsx` | Per-set card checklist (green=owned) |
| `/analytics` | `AnalyticsScreen.jsx` | Duplicates, top movers, rarity breakdown |
| `/wishlist` | `WishlistScreen.jsx` | Wishlist with price alerts |
| `/binders` | `BindersScreen.jsx` | Virtual binder management |
| `/products` | `ProductsScreen.jsx` | Sealed product P&L tracker |
| `/settings` | `SettingsScreen.jsx` | App configuration |

## Key Components

### `CardItem` / `CardModal` (`components/CardItem.jsx`)
- `CardItem` — grid tile showing card image, name, rarity, price. Click opens `CardModal`.
- `CardModal` — full detail popup: large image, all price fields (Cardmarket non-holo, holo, TCGPlayer), add-to-collection form with quantity/condition/variant/grade/purchase price.
- `CustomCardModal` — form to manually create a card not in TCGdex.
- Price display respects `pricePrimary` from `SettingsContext`.

### `SettingsContext` (`contexts/SettingsContext.jsx`)
Global context loaded from `/api/settings/` on mount. Provides:
- `t(path)` — i18n translation helper (DE/EN)
- `formatPrice(eurAmount)` — formats with currency symbol + optional USD conversion
- `pricePrimary` — which price field to use for values (`trend` | `avg1` | `avg7` | `avg30` | `low` | `market`)
- `priceDisplay` — array of price fields to show in the card detail
- `language` — `de` | `en`
- `currency` — `EUR` | `USD`
- `updateSettings(updates)` — persists changes to backend

### `PeriodSelector` (`components/PeriodSelector.jsx`)
Tab bar for selecting which Cardmarket price period to display. Maps period keys to card fields via `PERIOD_PRICE_FIELD`.

### `api/client.js`
Central Axios instance (`baseURL: '/api'`). All backend calls go through named exports here. Vite dev proxy forwards `/api/*` to the FastAPI backend.

## Styling
- Tailwind CSS with custom dark-theme design tokens in `tailwind.config.js`
- Custom CSS in `src/index.css` — `.card`, `.btn-primary`, `.input`, `.select` etc.
- `shadow-glow` Tailwind utility = `10px 18px 40px rgba(0,0,0,0.7), -3px 0 18px rgba(227,0,11,0.12), inset 0 0 0 1px rgba(255,255,255,0.08)` (defined in config but not used on card hover — replaced with `hover:border-brand-red/20`)
- Color palette: `bg-DEFAULT #08080f`, `brand-red #e3000b`, `text-primary #ffffff`

## i18n
Translations in `src/i18n/de.js` and `src/i18n/en.js`. The `t('key.path')` helper from `SettingsContext` does dot-notation lookup with German fallback.

## Price Field Mapping
```js
// In CardItem.jsx
const PRICE_FIELD_MAP = {
  avg: 'price_market',
  market: 'price_market',
  low: 'price_low',
  trend: 'price_trend',
  avg1: 'price_avg1',
  avg7: 'price_avg7',
  avg30: 'price_avg30',
}
```
`pricePrimary` from settings maps through this to `card[field]`.

## Language & Card IDs
- Card search supports `?lang=de|en|all` — filters by `cards.lang`
- Set checklist uses composite set IDs (`sv1_de`) as route param
- Card thumbnails and modals show `card.lang` badge (🇩🇪 / 🇬🇧)
