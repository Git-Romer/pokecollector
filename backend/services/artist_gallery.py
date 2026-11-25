"""Bounded, deterministic gallery picks from the artist index's visible catalogue rows."""
from services.card_values import effective_price_quote
from services.tcgdex_languages import strip_lang_suffix


def select_artist_previews(cards, *, price_field='price_trend', lang='all', allow_cross_language=False):
    identities = {}
    for card in cards:
        if lang != 'all' and card.lang != lang:
            continue
        identity = card.tcg_card_id or strip_lang_suffix(card.id)[0]
        quote = effective_price_quote(card, price_field=price_field,
                                      allow_cross_language=allow_cross_language)
        amount = quote['amount'] or None
        candidate = {
            'id': card.id, 'tcg_card_id': identity, 'name': card.name,
            'lang': card.lang,
            'images_small': getattr(card, 'images_small', None),
            'images_large': getattr(card, 'images_large', None),
            'valuation': {**quote, 'amount': amount},
        }
        previous = identities.get(identity)
        if previous is None or _rank(candidate) < _rank(previous):
            identities[identity] = candidate
    return sorted(identities.values(), key=_rank)[:3]


def _rank(card):
    amount = card['valuation']['amount']
    # Unknown prices sort after genuine values, never as invented zero prices.
    return (amount is None, -(amount or 0), card['tcg_card_id'], card['id'])
