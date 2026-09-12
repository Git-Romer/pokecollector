import unittest
from types import SimpleNamespace

from services.deck_analysis import analyze_deck


def card(name, supertype, **values):
    return SimpleNamespace(name=name, supertype=supertype, subtypes=values.get("subtypes", []), stage=values.get("stage"), types=values.get("types", []), hp=values.get("hp"), retreat=values.get("retreat"), attacks=values.get("attacks"), trainer_type=values.get("trainer_type"), energy_type=values.get("energy_type"))


def entry(identifier, quantity, card_value):
    return SimpleNamespace(id=identifier, required_quantity=quantity, card=card_value)


def deck(entries):
    return SimpleNamespace(entries=entries)


class DeckAnalysisTests(unittest.TestCase):
    def test_quantity_weighted_composition_stages_types_hp_and_retreat(self):
        basic = card("Pikachu", "Pokemon", subtypes=["Basic"], types=["Lightning"], hp="60", retreat=0, attacks=[{"cost": ["Lightning"], "damage": "30"}])
        stage_two = card("Charizard", "Pokemon", stage="Stage2", types=["Fire", "Flying"], hp="330", retreat=3, attacks=[{"cost": ["Fire", "Fire", "Colorless", "Colorless"], "damage": "200"}])
        result = analyze_deck(deck([entry(1, 4, basic), entry(2, 1, stage_two)]))
        self.assertEqual(result["composition"]["pokemon_count"], 5)
        self.assertEqual(result["pokemon"]["stages"], {"Basic": 4, "Stage 1": 0, "Stage 2": 1, "other_unknown": 0})
        self.assertEqual(result["pokemon"]["types"], {"Fire": 1, "Flying": 1, "Lightning": 4})
        self.assertEqual(result["pokemon"]["hp"], {"count": 5, "min": 60, "max": 330, "average": 114.0, "median": 60, "missing_hp": 0})
        self.assertEqual(result["pokemon"]["retreat"]["distribution"], {"0": 4, "1": 0, "2": 0, "3+": 1})

    def test_trainers_energy_and_missing_metadata_are_classified(self):
        item = card("Ultra Ball", "Trainer", trainer_type="Item")
        supporter = card("Research", "Trainer", subtypes=["Supporter"])
        basic_energy = card("Grass Energy", "Energy", subtypes=["Normal"], energy_type="Normal", types=["Grass"])
        special_energy = card("Double Turbo Energy", "Energy", subtypes=["Special"], energy_type="Special")
        unknown_pokemon = card("Old Card", "Pokemon", attacks=[])
        result = analyze_deck(deck([entry(1, 4, item), entry(2, 2, supporter), entry(3, 10, basic_energy), entry(4, 2, special_energy), entry(5, 3, unknown_pokemon)]))
        self.assertEqual(result["trainers"], {"Item": 4, "Supporter": 2, "Stadium": 0, "Tool": 0, "other_unknown": 0})
        self.assertEqual(result["energy"]["basic"], 10)
        self.assertEqual(result["energy"]["special"], 2)
        self.assertEqual(result["energy"]["types"], {"Grass": 10})
        self.assertEqual(result["pokemon"]["hp"]["missing_hp"], 3)
        self.assertEqual(result["pokemon"]["retreat"]["missing_retreat"], 3)

    def test_attack_damage_and_costs_keep_variable_damage_out_of_fixed_stats(self):
        attacker = card("Attacker", "Pokemon", attacks=[
            {"cost": [], "damage": "20"}, {"cost": ["Colorless"], "damage": "30+"}, {"cost": ["Colorless", "Colorless"], "damage": "20x"}, {"cost": ["Colorless", "Colorless", "Colorless"], "damage": ""}, {"cost": ["Colorless"] * 4, "damage": "?"}, {"damage": "100"},
        ])
        result = analyze_deck(deck([entry(1, 2, attacker)]))["attacks"]
        self.assertEqual(result["fixed_damage"], {"count": 4, "min": 20, "max": 100, "average": 60.0, "median": 60.0})
        self.assertEqual(result["variable_attack_count"], 4)
        self.assertEqual(result["non_damage_attack_count"], 2)
        self.assertEqual(result["unknown_attack_count"], 2)
        self.assertEqual(result["cost_distribution"], {"0": 2, "1": 2, "2": 2, "3": 2, "4+": 2, "unknown": 2})

    def test_diversity_uses_printings_and_normalized_names(self):
        result = analyze_deck(deck([entry(1, 2, card("Ultra Ball", "Trainer")), entry(2, 3, card("ultra ball", "Trainer")), entry(3, 1, card("Potion", "Trainer"))]))
        self.assertEqual(result["diversity"], {"total_cards": 6, "unique_printings": 3, "unique_card_names": 2})


if __name__ == "__main__":
    unittest.main()
