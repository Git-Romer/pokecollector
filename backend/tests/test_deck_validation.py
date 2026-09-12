import unittest
from types import SimpleNamespace

from services.deck_validation import validate_deck


def card(name, supertype="Trainer", subtypes=None, stage=None, energy_type=None, regulation_mark="H", fingerprint=None):
    return SimpleNamespace(name=name, supertype=supertype, subtypes=subtypes or [], stage=stage, energy_type=energy_type, regulation_mark=regulation_mark, playable_fingerprint=fingerprint, is_custom=False)


def entry(identifier, card_id, quantity, card_value):
    return SimpleNamespace(id=identifier, card_id=card_id, required_quantity=quantity, card=card_value)


def deck(target, entries, format="Casual"):
    return SimpleNamespace(target_size=target, entries=entries, format=format)


class DeckValidationTests(unittest.TestCase):
    def _valid_deck(self, target):
        basic = entry(1, "basic", 4, card("Pikachu", "Pokemon", ["Basic"]))
        energy = entry(2, "energy", target - 4, card("Lightning Energy", "Energy", ["Basic"]))
        return deck(target, [basic, energy])

    def test_valid_20_40_and_60_card_decks(self):
        for target in (20, 40, 60):
            result = validate_deck(self._valid_deck(target), {"basic": 4, "energy": target - 4})
            self.assertTrue(result["valid"])

    def test_under_and_over_target_are_errors(self):
        for target, actual in ((60, 59), (60, 61)):
            result = validate_deck(deck(target, [entry(1, "basic", actual, card("Pikachu", "Pokemon", ["Basic"]))]))
            self.assertEqual(result["errors"][0]["code"], "deck_size")

    def test_requires_basic_pokemon(self):
        result = validate_deck(deck(20, [entry(1, "trainer", 20, card("Ultra Ball"))]))
        self.assertIn("basic_pokemon", [check["code"] for check in result["errors"]])

    def test_copy_limits_aggregate_printings_and_exempt_basic_energy(self):
        basic = entry(1, "basic", 1, card("Pikachu", "Pokemon", ["Basic"]))
        first = entry(2, "ball-a", 2, card("Ultra Ball"))
        second = entry(3, "ball-b", 3, card("ultra ball"))
        energy_a = entry(4, "energy-a", 10, card("Grass Energy", "Energy", ["Basic"]))
        energy_b = entry(5, "energy-b", 10, card("Lightning Energy", "Energy", ["Basic"]))
        result = validate_deck(deck(26, [basic, first, second, energy_a, energy_b]))
        copy_check = next(check for check in result["checks"] if check["code"] == "copy_limit")
        self.assertEqual(copy_check["status"], "fail")
        self.assertEqual(copy_check["details"]["violations"], [{"name": "Ultra Ball", "quantity": 5}])

    def test_all_catalog_basic_energy_types_are_exempt_including_older_normal_metadata(self):
        energy_names = ["Grass Energy", "Fire Energy", "Water Energy", "Lightning Energy", "Psychic Energy", "Fighting Energy", "Darkness Energy", "Metal Energy", "Fairy Energy"]
        entries = [entry(index, f"energy-{index}", 20, card(name, "Energy", ["Normal"], energy_type="Normal")) for index, name in enumerate(energy_names, 1)]
        copy_check = next(check for check in validate_deck(deck(180, entries))["checks"] if check["code"] == "copy_limit")
        self.assertEqual(copy_check["status"], "pass")

    def test_energy_named_trainers_and_special_energy_remain_limited(self):
        entries = [
            entry(1, "switch-a", 2, card("Energy Switch", "Trainer", ["Item"])),
            entry(2, "switch-b", 3, card("Energy Switch", "Trainer", ["Item"])),
            entry(3, "retrieval", 5, card("Energy Retrieval", "Trainer", ["Item"])),
            entry(4, "search", 5, card("Energy Search", "Trainer", ["Item"])),
            entry(5, "recycler", 5, card("Energy Recycler", "Trainer", ["Item"])),
            entry(6, "special", 5, card("Double Turbo Energy", "Energy", ["Special"], energy_type="Special")),
        ]
        copy_check = next(check for check in validate_deck(deck(25, entries))["checks"] if check["code"] == "copy_limit")
        self.assertEqual(copy_check["status"], "fail")
        self.assertEqual({item["name"] for item in copy_check["details"]["violations"]}, {"Energy Switch", "Energy Retrieval", "Energy Search", "Energy Recycler", "Double Turbo Energy"})

    def test_ownership_shortage_is_a_warning(self):
        result = validate_deck(self._valid_deck(20), {"basic": 3, "energy": 16})
        self.assertFalse(result["warnings"] == [])
        self.assertEqual(result["warnings"][0]["code"], "ownership")
        self.assertNotIn("ownership", [check["code"] for check in result["errors"]])

    def test_standard_legality_and_unavailable_formats(self):
        legal = entry(1, "basic", 4, card("Pikachu", "Pokemon", ["Basic"], regulation_mark="H"))
        illegal = entry(2, "old", 16, card("Old Energy", "Energy", ["Basic"], regulation_mark="G"))
        standard = validate_deck(deck(20, [legal, illegal], "Standard"), standard_legal_fingerprints=set())
        self.assertEqual(next(check for check in standard["checks"] if check["code"] == "format_legality")["status"], "fail")
        expanded = validate_deck(deck(20, [legal, illegal], "Expanded"))
        self.assertEqual(next(check for check in expanded["checks"] if check["code"] == "format_legality")["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
