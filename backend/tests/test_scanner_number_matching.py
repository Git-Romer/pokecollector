import unittest

try:
    from api.recognize import prioritize_cards_by_number
    DEPS_AVAILABLE = True
except ModuleNotFoundError:
    DEPS_AVAILABLE = False

skip_without_deps = unittest.skipUnless(
    DEPS_AVAILABLE, "FastAPI/SQLAlchemy are not installed in this lightweight test environment"
)


@skip_without_deps
class AlphanumericNumberTests(unittest.TestCase):
    """Trainer gallery, promo and suffixed collector numbers.

    Matching on leading digits alone cannot see these: "TG01" has none, so
    nothing is prioritised and the card stays below the candidate cap - the
    truncation this prioritising exists to prevent.
    """

    def test_a_trainer_gallery_number_is_prioritised(self):
        cards = [{"id": f"filler-{n}", "number": str(n)} for n in range(1, 40)]
        cards.append({"id": "wanted", "number": "TG01"})

        prioritized, count = prioritize_cards_by_number(cards, "TG01")

        self.assertEqual(count, 1)
        self.assertEqual(prioritized[0]["id"], "wanted")
        # The candidate list is capped downstream, so first place is what counts.
        self.assertIn("wanted", [c["id"] for c in prioritized[:8]])

    def test_a_promo_style_number_is_prioritised(self):
        cards = [{"id": "other", "number": "12"}, {"id": "wanted", "number": "SV107"}]
        prioritized, count = prioritize_cards_by_number(cards, "SV107")
        self.assertEqual(count, 1)
        self.assertEqual(prioritized[0]["id"], "wanted")


@skip_without_deps
class SuffixedNumberTests(unittest.TestCase):
    """"74a" and "74" are different, real cards."""

    def test_a_suffixed_number_does_not_match_the_plain_one(self):
        cards = [{"id": "plain-74", "number": "74"}]
        prioritized, count = prioritize_cards_by_number(cards, "74a")
        self.assertEqual(count, 0)
        self.assertEqual([c["id"] for c in prioritized], ["plain-74"])

    def test_a_suffixed_number_matches_its_own_card(self):
        cards = [{"id": "plain-74", "number": "74"}, {"id": "suffixed", "number": "74a"}]
        prioritized, count = prioritize_cards_by_number(cards, "74a")
        self.assertEqual(count, 1)
        self.assertEqual(prioritized[0]["id"], "suffixed")

    def test_the_plain_number_does_not_match_the_suffixed_card(self):
        cards = [{"id": "suffixed", "number": "74a"}]
        prioritized, count = prioritize_cards_by_number(cards, "74")
        self.assertEqual(count, 0)


@skip_without_deps
class ExistingBehaviourTests(unittest.TestCase):
    """The cases upstream already handles must keep working."""

    def test_leading_zeros_and_set_totals_still_meet(self):
        cards = [
            {"id": "before", "number": "5"},
            {"id": "first-match", "number": "063"},
            {"id": "second-match", "number": "63/100"},
        ]
        prioritized, count = prioritize_cards_by_number(cards, "063/100")
        self.assertEqual(count, 2)
        self.assertEqual(
            [c["id"] for c in prioritized],
            ["first-match", "second-match", "before"],
        )

    def test_an_unreadable_number_leaves_the_order_alone(self):
        cards = [{"id": "first", "number": "1"}, {"id": "second", "number": "2"}]
        for recognized in (None, "", "No. 039", "999"):
            with self.subTest(recognized=recognized):
                prioritized, count = prioritize_cards_by_number(cards, recognized)
                self.assertEqual(count, 0)
                self.assertEqual([c["id"] for c in prioritized], ["first", "second"])


if __name__ == "__main__":
    unittest.main()
