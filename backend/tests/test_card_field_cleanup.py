import unittest

try:
    from services.card_field_cleanup import (
        clean_card_info, energy_search_name, energy_type_name, is_generic_energy_name,
    )
    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "services not importable in this lightweight test environment")
class EnergyCardTests(unittest.TestCase):
    """A basic Energy card prints "Basic Energy"; TCGdex calls it "Water Energy".

    On a real 72-card set every wrongly-matched card was a basic Energy, and this
    name gap was the whole cause: the printed name matched nothing, and the prefix
    fallback then trimmed it to "Basic" and matched an unrelated pool.
    """

    def test_builds_the_catalogue_name_from_the_symbol(self):
        card = {"card_type": "Energy", "name_en": "Basic Energy", "energy_type": "Water"}
        self.assertEqual(energy_search_name(card), "Water Energy")

    def test_covers_the_bare_energy_spelling_too(self):
        # Vintage Base Set energies print only "ENERGY".
        card = {"card_type": "Energy", "name_en": "ENERGY", "energy_type": "fighting"}
        self.assertEqual(energy_search_name(card), "Fighting Energy")

    def test_leaves_a_special_energy_alone(self):
        # "Double Turbo Energy" is its real catalogue name — searching it works,
        # and replacing it with "Colorless Energy" would lose the card.
        card = {"card_type": "Energy", "name_en": "Double Turbo Energy",
                "energy_type": "Colorless"}
        self.assertIsNone(energy_search_name(card))

    def test_leaves_a_name_that_already_carries_its_type(self):
        card = {"card_type": "Energy", "name_en": "Basic Water Energy", "energy_type": "Water"}
        self.assertIsNone(energy_search_name(card))

    def test_no_substitution_without_a_type(self):
        card = {"card_type": "Energy", "name_en": "Basic Energy", "energy_type": None}
        self.assertIsNone(energy_search_name(card))

    def test_never_applies_to_a_pokemon(self):
        # A Pokemon named "...Energy" must not be rewritten.
        card = {"card_type": "Pokemon", "name_en": "Energy", "energy_type": "Water"}
        self.assertIsNone(energy_search_name(card))

    def test_rejects_a_type_that_does_not_exist(self):
        card = {"card_type": "Energy", "name_en": "Basic Energy", "energy_type": "Shadow"}
        self.assertIsNone(energy_search_name(card))

    def test_canonicalises_capitalisation(self):
        self.assertEqual(energy_type_name("water"), "Water")
        self.assertEqual(energy_type_name("  METAL "), "Metal")
        self.assertIsNone(energy_type_name("Shadow"))
        self.assertIsNone(energy_type_name(None))

    def test_cleanup_drops_an_invented_type(self):
        self.assertIsNone(clean_card_info({"energy_type": "Sparkle"})["energy_type"])
        self.assertEqual(clean_card_info({"energy_type": "psychic"})["energy_type"], "Psychic")

    def test_generic_names_are_flagged_so_the_prefix_trim_is_skipped(self):
        for name in ("Basic Energy", "ENERGY", "basic  energy"):
            self.assertTrue(is_generic_energy_name(name), name)

    def test_a_real_card_name_is_not_flagged_as_generic(self):
        for name in ("Double Turbo Energy", "Exeggcute", "", None):
            self.assertFalse(is_generic_energy_name(name), name)


if __name__ == "__main__":
    unittest.main()
