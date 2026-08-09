import unittest

from services.card_numbers import card_number_matches, normalize_card_number, card_number_variants, printed_number_variants


class CardNumberTests(unittest.TestCase):
    def test_numeric_numbers_match_with_or_without_leading_zeroes(self):
        self.assertTrue(card_number_matches("044", "44"))
        self.assertTrue(card_number_matches("44", "044"))
        self.assertTrue(card_number_matches("000", "0"))

    def test_different_numeric_numbers_do_not_match(self):
        self.assertFalse(card_number_matches("045", "44"))

    def test_non_numeric_numbers_still_match_case_insensitively(self):
        self.assertTrue(card_number_matches("TG01", "tg01"))
        self.assertFalse(card_number_matches("TG01", "1"))

    def test_normalization_preserves_empty_value(self):
        self.assertEqual(normalize_card_number(None), "")
        self.assertEqual(normalize_card_number(""), "")


if __name__ == "__main__":
    unittest.main()


class NumberVariantTests(unittest.TestCase):
    """Forms a printed number can legitimately take in the catalogue."""

    def test_the_set_total_is_dropped(self):
        self.assertEqual(printed_number_variants("63/100"), ["63"])

    def test_zero_padding_is_offered_both_ways(self):
        # TCGdex is inconsistent between sets: Base Set Charizard is localId "4"
        # while Phantasmal Flames Charmeleon is "012".
        self.assertEqual(card_number_variants("63/100"), ["63", "063"])
        self.assertEqual(card_number_variants("063"), ["063", "63"])

    def test_an_alphanumeric_number_is_kept_verbatim(self):
        self.assertEqual(card_number_variants("TG01"), ["TG01"])
        self.assertEqual(card_number_variants("SV107"), ["SV107"])

    def test_a_suffix_is_never_reduced_away(self):
        # "74" is a different, real card.
        self.assertEqual(card_number_variants("74a"), ["74a"])
        self.assertNotIn("74", card_number_variants("74a"))

    def test_unreadable_values_yield_nothing(self):
        for value in (None, "", "No. 039"):
            with self.subTest(value=value):
                self.assertEqual(card_number_variants(value), [])
