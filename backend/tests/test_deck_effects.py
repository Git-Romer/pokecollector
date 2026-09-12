import unittest
from types import SimpleNamespace

from services.deck_effects import analyze_deck_effects, classify_effects, normalize_effect_text


def card(name, effect=None, abilities=None, attacks=None):
    return SimpleNamespace(name=name, card_effect=effect, abilities=abilities, attacks=attacks)


def entry(identifier, quantity, card_value):
    return SimpleNamespace(id=identifier, card_id=f"card-{identifier}", required_quantity=quantity, card=card_value)


def deck(entries):
    return SimpleNamespace(entries=entries)


class DeckEffectsTests(unittest.TestCase):
    def test_representative_trainer_effects_receive_multiple_precise_tags(self):
        professor = card("Professor's Research", "Discard your hand and draw 7 cards.")
        ultra = card("Ultra Ball", "Discard 2 cards from your hand. Search your deck for a Pokémon.")
        nest = card("Nest Ball", "Search your deck for a Basic Pokémon and put it onto your Bench.")
        switch = card("Switch", "Switch 1 of your own Benched Pokémon with your Active Pokémon.")
        boss = card("Boss's Orders", "Switch 1 of your opponent's Benched Pokémon with their Active Pokémon.")
        retrieval = card("Energy Retrieval", "Put 2 basic Energy cards from your discard pile into your hand.")
        healing = card("Potion", "Heal 30 damage from 1 of your Pokémon.")
        disruption = card("Iono", "Each player shuffles their hand into their deck.")
        self.assertEqual(classify_effects(professor), {"draw", "discard"})
        self.assertEqual(classify_effects(ultra), {"pokemon_search", "discard"})
        self.assertEqual(classify_effects(nest), {"pokemon_search"})
        self.assertEqual(classify_effects(switch), {"switching"})
        self.assertEqual(classify_effects(boss), {"gust"})
        self.assertEqual(classify_effects(retrieval), {"energy_recovery", "general_recovery"})
        self.assertEqual(classify_effects(healing), {"healing"})
        self.assertEqual(classify_effects(disruption), {"hand_disruption"})

    def test_coverage_weights_quantities_and_uses_unique_sources(self):
        result = analyze_deck_effects(deck([
            entry(1, 4, card("Ultra Ball", "Discard 2 cards. Search your deck for a Pokémon.")),
            entry(2, 3, card("Nest Ball", "Search your deck for a Basic Pokémon.")),
            entry(3, 2, card("Research", "Draw 7 cards.")),
        ]))
        self.assertEqual(result["coverage"]["pokemon_search"]["cards"], 7)
        self.assertEqual(result["coverage"]["pokemon_search"]["unique_sources"], 2)
        self.assertEqual(result["outs"]["draw_outs"]["cards"], 2)
        self.assertEqual(result["coverage"]["discard"]["cards"], 4)

    def test_aggregate_outs_do_not_double_count_one_multi_tag_source(self):
        result = analyze_deck_effects(deck([
            entry(1, 4, card("Energy Engine", "Search your deck for an Energy card, then attach an Energy to your Pokémon.")),
            entry(2, 2, card("Energy Retrieval", "Put 2 Energy cards from your discard pile into your hand.")),
            entry(3, 1, card("Recovery", "Put a Pokémon from your discard pile into your hand.")),
        ]))
        self.assertEqual(result["outs"]["energy_access_outs"]["cards"], 4)
        self.assertEqual(result["outs"]["recovery_outs"]["cards"], 3)

    def test_abilities_attacks_german_and_incomplete_metadata_are_handled(self):
        ability = card("Ability Draw", abilities=[{"effect": "Once during your turn, draw 2 cards."}])
        attack = card("Attack Search", attacks=[{"effect": "Search your deck for a Pokémon."}])
        german = card("Forschung", "Lege deine Handkarten auf deinen Ablagestapel und ziehe 7 Karten.")
        unknown = card("Old Card")
        result = analyze_deck_effects(deck([entry(1, 2, ability), entry(2, 3, attack), entry(3, 1, german), entry(4, 4, unknown)]))
        self.assertEqual(result["coverage"]["draw"]["cards"], 3)
        self.assertEqual(result["coverage"]["pokemon_search"]["cards"], 3)
        self.assertEqual(result["unclassified_cards"], {"cards": 4, "unique_sources": 1})
        self.assertEqual(normalize_effect_text(" Draw\n 2  cards. "), "draw 2 cards.")

    def test_opponent_drawing_does_not_count_as_draw_support(self):
        self.assertNotIn("draw", classify_effects(card("Watcher", "If your opponent draws 2 cards, do 30 damage.")))


if __name__ == "__main__":
    unittest.main()
