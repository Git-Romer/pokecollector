import unittest
from math import comb
from types import SimpleNamespace

from services.deck_probability import analyze_deck_probability, prize_risk, probability_at_least


def card(name, supertype="Trainer", subtypes=None, stage=None, effect=None):
    return SimpleNamespace(name=name, supertype=supertype, subtypes=subtypes or [], stage=stage, card_effect=effect, abilities=[], attacks=[])


def entry(identifier, quantity, card_value):
    return SimpleNamespace(id=identifier, card_id=f"card-{identifier}", required_quantity=quantity, card=card_value)


def deck(entries):
    return SimpleNamespace(entries=entries)


class DeckProbabilityTests(unittest.TestCase):
    def test_hypergeometric_helper_known_and_invalid_cases(self):
        self.assertEqual(probability_at_least(4, 1, 2), 0.5)
        self.assertEqual(probability_at_least(60, 0, 7), 0.0)
        self.assertEqual(probability_at_least(0, 1, 7), 0.0)
        self.assertEqual(probability_at_least(4, 1, 9), 1.0)

    def test_one_and_four_copy_opening_odds(self):
        one = probability_at_least(60, 1, 7)
        four = probability_at_least(60, 4, 7)
        self.assertAlmostEqual(one, 7 / 60)
        self.assertAlmostEqual(four, 1 - comb(56, 7) / comb(60, 7))

    def test_basic_same_name_outs_and_cards_seen_use_quantity(self):
        basic = card("Pikachu", "Pokemon", ["Basic"])
        ultra_a = card("Ultra Ball", effect="Search your deck for a Pokémon.")
        ultra_b = card("ultra ball", effect="Search your deck for a Pokémon.")
        draw = card("Research", effect="Draw 7 cards.")
        filler = card("Filler")
        result = analyze_deck_probability(deck([entry(1, 9, basic), entry(2, 2, ultra_a), entry(3, 2, ultra_b), entry(4, 4, draw), entry(5, 43, filler)]), hand_size=7, subsequent_draws=2, card_name="Ultra Ball")
        self.assertEqual(result["deck_size"], 60)
        self.assertEqual(result["basic_pokemon"]["count"], 9)
        self.assertAlmostEqual(result["basic_pokemon"]["none"], 1 - result["basic_pokemon"]["at_least_one"])
        self.assertEqual(result["key_card"]["copies"], 4)
        self.assertEqual(result["outs"]["pokemon_search_outs"]["count"], 4)
        self.assertGreater(result["key_card"]["cards_seen_probability"], result["key_card"]["opening_probability"])

    def test_prize_risk_and_expected_prized_copies(self):
        one = prize_risk(60, 1, 6)
        self.assertAlmostEqual(one["at_least_one"], 0.1)
        self.assertAlmostEqual(one["all_copies"], 0.1)
        self.assertAlmostEqual(one["expected_copies"], 0.1)
        multi = prize_risk(60, 4, 6)
        self.assertAlmostEqual(multi["all_copies"], comb(56, 2) / comb(60, 6))
        self.assertAlmostEqual(multi["expected_copies"], 0.4)

    def test_over_target_deck_uses_actual_total(self):
        result = analyze_deck_probability(deck([entry(1, 4, card("Ultra Ball")), entry(2, 57, card("Filler"))]), hand_size=7, card_name="Ultra Ball", prize_count=6)
        self.assertEqual(result["deck_size"], 61)
        self.assertAlmostEqual(result["key_card"]["opening_probability"], probability_at_least(61, 4, 7))


if __name__ == "__main__":
    unittest.main()
