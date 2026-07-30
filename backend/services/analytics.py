import html
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from math import ceil
def sort_top_movers(results, sort_by="percentage"):
    sort_field = "change_abs" if sort_by == "absolute" else "change_pct"
    return sorted(results, key=lambda x: abs(x[sort_field]), reverse=True)


def summarize_collection_intents(entries):
    scoped = {'vault': [], 'pc': [], 'main_collection': []}
    for entry in entries:
        intent = entry.get('intent') or 'main_collection'
        scoped[intent if intent in scoped else 'main_collection'].append(entry)

    main = sorted(scoped['main_collection'], key=lambda entry: entry['market_value'], reverse=True)
    main_count = max(1, ceil(len(main) * 0.10)) if main else 0
    scope_entries = {'vault': scoped['vault'], 'pc': scoped['pc'], 'main_collection': main[:main_count]}

    result = {}
    for scope, lots in scope_entries.items():
        market_value = round(sum(lot['market_value'] for lot in lots), 2)
        valued_lots = [lot for lot in lots if lot['unit_cost'] is not None]
        missing_lots = [lot for lot in lots if lot['unit_cost'] is None]
        cost_basis = round(sum(lot['unit_cost'] * lot['quantity'] for lot in valued_lots), 2)
        profit_loss = round(sum(lot['market_value'] - lot['unit_cost'] * lot['quantity'] for lot in valued_lots), 2)
        result[scope] = {
            'market_value': market_value,
            'cost_basis': cost_basis,
            'profit_loss': profit_loss,
            'return_percentage': round(profit_loss / cost_basis * 100, 1) if cost_basis else None,
            'lots': len(lots),
            'cards': sum(lot['quantity'] for lot in lots if not lot.get('sealed_product')),
            'sealed_products': sum(1 for lot in lots if lot.get('sealed_product')),
            'cost_basis_needed': {
                'lots': len(missing_lots),
                'cards': sum(lot['quantity'] for lot in missing_lots if not lot.get('sealed_product')),
                'sealed_products': sum(1 for lot in missing_lots if lot.get('sealed_product')),
                'market_value': round(sum(lot['market_value'] for lot in missing_lots), 2),
            },
        }
    return result


POKEBEACH_URL = 'https://www.pokebeach.com/'
POKEBEACH_CACHE_PATH = Path(os.getenv('BACKUP_DIR', '/app/backups')) / 'cache' / 'pokebeach-news.json'
POKEBEACH_CACHE_TTL = timedelta(hours=6)

def _pokebeach_category(title: str) -> str:
    normalized = title.lower()
    if any(token in normalized for token in ('deck', 'strategy', 'league', 'tournament', 'worlds', 'beat ', 'review')):
        return 'Meta & Deckbuilding'
    if any(token in normalized for token in ('set', 'cards revealed', 'secret rares', 'expansion', 'preorder', 'release')):
        return 'New Set Drops'
    return 'Trending Cards'

def _read_pokebeach_cache() -> dict | None:
    try:
        return json.loads(POKEBEACH_CACHE_PATH.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None

def _write_pokebeach_cache(payload: dict) -> None:
    try:
        POKEBEACH_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = POKEBEACH_CACHE_PATH.with_suffix('.tmp')
        temporary.write_text(json.dumps(payload), encoding='utf-8')
        temporary.replace(POKEBEACH_CACHE_PATH)
    except OSError:
        pass

def get_pokebeach_news(limit: int = 9) -> dict:
    """Return a cached, read-only PokéBeach discovery feed.

    When the public page cannot be reached, the newest local cache is returned
    with its original timestamp so the UI can explain that it is cached.
    """
    cached = _read_pokebeach_cache()
    if cached:
        try:
            fetched_at = datetime.fromisoformat(cached['fetched_at'])
            if datetime.now(timezone.utc) - fetched_at < POKEBEACH_CACHE_TTL:
                return {**cached, 'cached': True}
        except (KeyError, ValueError):
            pass

    try:
        response = httpx.get(POKEBEACH_URL, headers={'User-Agent': 'John-Johns-PC/1.0 (+local collection archive)'}, timeout=12.0, follow_redirects=True)
        response.raise_for_status()
        matches = re.findall(r'<h2[^>]*>\s*<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', response.text, flags=re.IGNORECASE | re.DOTALL)
        items = []
        seen = set()
        for href, raw_title in matches:
            title = html.unescape(re.sub(r'<[^>]+>', '', raw_title)).strip()
            if not title or title in seen:
                continue
            seen.add(title)
            url = href if href.startswith('http') else f'https://www.pokebeach.com{href}'
            items.append({'title': title, 'url': url, 'category': _pokebeach_category(title), 'source': 'PokéBeach'})
            if len(items) >= limit:
                break
        if not items:
            raise ValueError('PokéBeach page did not contain readable news entries')
        payload = {'source': 'PokéBeach', 'fetched_at': datetime.now(timezone.utc).isoformat(), 'items': items, 'cached': False}
        _write_pokebeach_cache(payload)
        return payload
    except (httpx.HTTPError, ValueError, OSError):
        if cached:
            return {**cached, 'cached': True}
        return {'source': 'PokéBeach', 'fetched_at': None, 'items': [], 'cached': True}
