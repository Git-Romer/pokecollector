import unittest

from services.card_numbers import card_number_matches, normalize_card_number


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
