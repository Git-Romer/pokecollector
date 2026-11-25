"""Collection organisation, using the Pokédex's existing species catalogue."""
import math
from services.pokedex import MAX_DEX_ID, pokedex_by_id
from services.card_values import effective_market_price


def collection_species(items, *, price_field='price_trend', language='en'):
    groups = {}
    other = {'items': [], 'copies': 0, 'total_value': 0.0}
    for item in items:
        card = item.card
        ids = []
        if not card.is_custom and str(card.supertype or '').casefold() in {'', 'pokemon', 'pokémon'}:
            for raw in card.dex_ids if isinstance(card.dex_ids, list) else []:
                if isinstance(raw, bool) or not isinstance(raw, (str, int, float)):
                    continue
                try:
                    value = float(raw)
                except ValueError:
                    continue
                if math.isfinite(value) and value.is_integer() and 1 <= value <= MAX_DEX_ID:
                    ids.append(int(value))
        dex_id = ids[0] if ids else None
        value = effective_market_price(card, item.variant, price_field) * item.quantity
        if dex_id is None:
            bucket = other
        else:
            if dex_id not in groups:
                entry = pokedex_by_id()[dex_id]
                groups[dex_id] = {
                    'dex_id': dex_id, 'name': entry.get(f'name_{language}') or entry['name_en'],
                    'items': [], 'copies': 0, 'total_value': 0.0, '_printings': set(),
                }
            bucket = groups[dex_id]
            bucket['_printings'].add(item.card_id)
        bucket['items'].append(item)
        bucket['copies'] += item.quantity
        bucket['total_value'] += value
    ordered = [groups[key] for key in sorted(groups)]
    for bucket in ordered:
        bucket['printing_count'] = len(bucket.pop('_printings'))
    buckets = [*ordered, other]
    return {
        'groups': ordered, 'other': other,
        'summary': {
            'entries': sum(len(bucket['items']) for bucket in buckets),
            'copies': sum(bucket['copies'] for bucket in buckets),
            'total_value': sum(bucket['total_value'] for bucket in buckets),
        },
    }
