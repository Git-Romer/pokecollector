import unittest

from services.deck_comparison import compare_decks


def deck(entries, *, composition=None, missing=0, checks=None, effects=None):
    return {
        "entries": entries, "composition_counts": composition or {"Pokemon": 0, "Trainer": 0, "Energy": 0, "Other": 0},
        "missing_copy_count": missing,
        "validation": {"checks": checks or [], "valid": not checks},
        "analysis": {"effects": effects or {"coverage": {}}},
    }


def entry(card_id, name, quantity, **card):
    return {"card_id": card_id, "required_quantity": quantity, "card": {"name": name, **card}}


class DeckComparisonTests(unittest.TestCase):
    def test_identical_decks_have_no_gameplay_card_differences(self):
        source = deck([entry("a", "Ultra Ball", 4)])
        result = compare_decks(source, source)
        self.assertEqual(result["cards"]["changes"][0]["status"], "unchanged")
        self.assertEqual(result["composition"], [])

    def test_added_removed_and_quantity_changed_cards(self):
        left = deck([entry("a", "Ultra Ball", 2), entry("b", "Switch", 1)])
        right = deck([entry("a", "Ultra Ball", 4), entry("c", "Boss's Orders", 1)])
        changes = {item["name"]: item for item in compare_decks(left, right)["cards"]["changes"]}
        self.assertEqual(changes["Ultra Ball"]["delta"], 2)
        self.assertEqual(changes["Switch"]["status"], "removed")
        self.assertEqual(changes["Boss's Orders"]["status"], "added")

    def test_same_name_printing_swap_is_not_a_gameplay_change(self):
        left = deck([entry("old", "Ultra Ball", 4, set_id="sv1", number="1", lang="en")])
        right = deck([entry("new", "Ultra Ball", 4, set_id="sv2", number="2", lang="de")])
        change = compare_decks(left, right)["cards"]["changes"][0]
        self.assertEqual(change["status"], "unchanged")
        self.assertEqual(change["printings"]["left"][0]["card_id"], "old")
        self.assertEqual(change["printings"]["right"][0]["card_id"], "new")

    def test_composition_ownership_validation_and_effect_deltas(self):
        left = deck([], composition={"Pokemon": 18, "Trainer": 30, "Energy": 12, "Other": 0}, missing=4, checks=[{"code": "copy_limit", "status": "pass"}], effects={"coverage": {"draw": {"cards": 8}}})
        right = deck([], composition={"Pokemon": 16, "Trainer": 32, "Energy": 12, "Other": 0}, missing=1, checks=[{"code": "copy_limit", "status": "fail"}], effects={"coverage": {"draw": {"cards": 11}}})
        result = compare_decks(left, right)
        self.assertEqual(result["ownership"]["delta"], -3)
        self.assertEqual(result["validation"]["changes"][0]["code"], "copy_limit")
        self.assertEqual(result["effects"]["changes"][0]["delta"], 3)


if __name__ == "__main__":
    unittest.main()
