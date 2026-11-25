"""Ranking contract for artist-gallery artwork. No provider calls or ownership input."""
import unittest
from types import SimpleNamespace
from services.artist_gallery import select_artist_previews


def card(identity, price=None, lang='en', **fields):
    return SimpleNamespace(id=f'{identity}_{lang}', tcg_card_id=identity, name=identity,
                           lang=lang, price_market=price, **fields)


class ArtistGalleryTests(unittest.TestCase):
    def select(self, cards, **kwargs):
        return select_artist_previews(cards, price_field='price_trend', **kwargs)

    def test_three_highest_values_not_input_order(self):
        result = self.select([card('a', 2), card('b', 20), card('c', 9), card('d', 11)])
        self.assertEqual([x['tcg_card_id'] for x in result], ['b', 'd', 'c'])

    def test_languages_do_not_use_multiple_slots_for_one_card(self):
        result = self.select([card('a', 9), card('a', 12, 'de'), card('b', 8), card('c', 7)])
        self.assertEqual([x['tcg_card_id'] for x in result], ['a', 'b', 'c'])
        self.assertEqual(result[0]['lang'], 'de')

    def test_selected_language_only(self):
        result = self.select([card('a', 9), card('b', 99, 'de')], lang='en')
        self.assertEqual([x['id'] for x in result], ['a_en'])

    def test_unpriced_cards_fill_remaining_slots_without_zero_price(self):
        result = self.select([card('b'), card('a', 2), card('c', 0)])
        self.assertEqual([x['tcg_card_id'] for x in result], ['a', 'b', 'c'])
        self.assertEqual([x['valuation']['amount'] for x in result], [2, None, None])

    def test_nonfinite_negative_and_boolean_prices_are_unavailable(self):
        result = self.select([card('a', float('inf')), card('b', float('nan')), card('c', True), card('d', -2), card('e', 5)])
        self.assertEqual(result[0]['id'], 'e_en')
        self.assertTrue(all(x['valuation']['amount'] is None for x in result[1:]))

    def test_shared_price_preference_and_cardmarket_fallback(self):
        result = self.select([card('a', 99, price_trend=1), card('b', 3), card('c', 4)])
        self.assertEqual([x['id'] for x in result], ['c_en', 'b_en', 'a_en'])

    def test_tcgplayer_conversion_only_when_cardmarket_is_missing(self):
        result = self.select([card('a', None, price_tcg_normal_market=10, price_tcg_usd_to_eur=.9), card('b', 5, price_tcg_normal_market=100, price_tcg_usd_to_eur=.9)])
        self.assertEqual(result[0]['id'], 'a_en')
        self.assertEqual(result[0]['valuation']['source'], 'tcgplayer')
        self.assertEqual(result[0]['valuation']['amount'], 9)
        self.assertEqual(result[1]['valuation']['amount'], 5)

    def test_german_fallback_honors_existing_permission(self):
        c = card('a', None, 'de', price_tcg_normal_market=10, price_tcg_usd_to_eur=.9)
        self.assertEqual(self.select([c], allow_cross_language=True)[0]['valuation']['amount'], 9)
        self.assertIsNone(self.select([c], allow_cross_language=False)[0]['valuation']['amount'])

    def test_other_languages_do_not_gain_tcgplayer_fallback(self):
        c = card('a', None, 'fr', price_tcg_normal_market=10, price_tcg_usd_to_eur=.9)
        self.assertIsNone(self.select([c], allow_cross_language=True)[0]['valuation']['amount'])

    def test_variant_quotes_must_match_the_card(self):
        c = card('a', None, variants_holo=True, variants_normal=False, price_tcg_normal_market=100, price_tcg_holo_market=5, price_tcg_usd_to_eur=.9)
        self.assertEqual(self.select([c])[0]['valuation']['amount'], 4.5)

    def test_ties_are_deterministic_and_short_catalogues_stay_short(self):
        self.assertEqual([x['id'] for x in self.select([card('b', 3), card('a', 3)])], ['a_en', 'b_en'])
        self.assertEqual(self.select([]), [])


if __name__ == '__main__':
    unittest.main()
