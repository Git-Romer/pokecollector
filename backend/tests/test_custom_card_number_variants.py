import unittest

DEPS_AVAILABLE = True
try:
    from services.card_numbers import (
        candidate_card_ids,
        card_number_variants,
        number_matches_candidate,
        printed_number_variants,
    )
except ModuleNotFoundError:  # pragma: no cover
    DEPS_AVAILABLE = False


@unittest.skipUnless(DEPS_AVAILABLE, "backend dependencies are not installed")
class CustomCardNumberVariantTests(unittest.TestCase):
    """TCGdex pads localId inconsistently, so one literal id is not enough."""

    def test_padded_and_unpadded_are_both_offered(self):
        # The reason this exists. Against the live catalogue today:
        #   me02-12  -> 404      me02-012 -> 200
        #   base1-4  -> 200      base1-004 -> 404
        # so a verbatim id misses in one direction or the other depending on
        # the set, and both forms have to be tried.
        self.assertEqual(candidate_card_ids("me02", "12"), ["me02-12", "me02-012"])
        self.assertIn("base1-4", candidate_card_ids("base1", "004"))

    def test_a_number_still_carrying_its_set_total_is_usable(self):
        # Manually entered cards often keep the printed "001/093" form.
        self.assertEqual(candidate_card_ids("B2a", "001/093"), ["B2a-001", "B2a-1"])

    def test_a_suffix_is_never_dropped(self):
        # 74a and 74 are different, real cards. Reducing one to the other would
        # silently match the wrong card, which is worse than not matching.
        self.assertEqual(printed_number_variants("74a/102"), ["74a"])
        self.assertNotIn("74", card_number_variants("74a"))

    def test_a_prefixed_number_survives(self):
        self.assertEqual(printed_number_variants("TG01/TG30"), ["TG01"])

    def test_a_candidate_is_confirmed_rather_than_trusted(self):
        # An id resolving is not proof it is the right card.
        self.assertTrue(number_matches_candidate("12", "012"))
        self.assertTrue(number_matches_candidate("012", "12"))
        self.assertFalse(number_matches_candidate("74a", "74"))
        self.assertFalse(number_matches_candidate("74", "74a"))

    def test_malformed_input_yields_nothing_rather_than_a_wrong_guess(self):
        self.assertEqual(candidate_card_ids("me02", ""), [])
        self.assertEqual(candidate_card_ids("", "12"), [])
        self.assertEqual(printed_number_variants("12/34/56"), [])

    def test_an_absent_local_id_is_not_treated_as_a_contradiction(self):
        # Some catalogue payloads carry no localId. The id we asked for is
        # itself the constraint, so an absent field must not veto the match;
        # only a present and mismatched one should.
        self.assertFalse(number_matches_candidate("12", None))
        self.assertFalse(number_matches_candidate("12", ""))

    def test_the_candidate_list_stays_short(self):
        # Each candidate is one catalogue request, so the list must not grow.
        for number in ("12", "012", "74a", "TG01", "001/093"):
            self.assertLessEqual(len(candidate_card_ids("set", number)), 3, number)


if __name__ == "__main__":
    unittest.main()
