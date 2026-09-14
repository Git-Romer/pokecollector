import unittest
from types import SimpleNamespace

from services.collection_csv import (
    collection_import_key,
    is_valid_collection_purchase_price,
    merge_collection_import_item,
    normalize_collection_variant,
)


class CollectionCsvTests(unittest.TestCase):
    def test_blank_variant_normalizes_to_normal(self):
        self.assertEqual(normalize_collection_variant(''), 'Normal')
        self.assertEqual(normalize_collection_variant(None), 'Normal')
        self.assertEqual(normalize_collection_variant(' Holo '), 'Holo')

    def test_purchase_price_must_be_finite_and_non_negative(self):
        self.assertTrue(is_valid_collection_purchase_price(0))
        self.assertTrue(is_valid_collection_purchase_price(12.5))
        self.assertFalse(is_valid_collection_purchase_price(-0.01))
        self.assertFalse(is_valid_collection_purchase_price(float('nan')))
        self.assertFalse(is_valid_collection_purchase_price(float('inf')))
        self.assertFalse(is_valid_collection_purchase_price(float('-inf')))

    def test_import_key_uses_exact_collection_attributes(self):
        key = collection_import_key('swshp-SWSH057_de', '', 'de', 'NM', None)
        self.assertEqual(key, ('swshp-SWSH057_de', 'Normal', 'de', 'NM', None, ()))

    def test_different_collection_attributes_stay_separate(self):
        normal_key = collection_import_key('swshp-SWSH057_de', 'Normal', 'de', 'NM', None)
        holo_key = collection_import_key('swshp-SWSH057_de', 'Holo', 'de', 'NM', None)
        priced_key = collection_import_key('swshp-SWSH057_de', 'Normal', 'de', 'NM', 1.5)

        self.assertNotEqual(normal_key, holo_key)
        self.assertNotEqual(normal_key, priced_key)

    def test_printing_details_are_normalized_as_part_of_the_import_identity(self):
        accented = collection_import_key(
            'swshp-SWSH057_de', 'Holo', 'de', 'NM', None,
            ['Poké Ball', 'Play! Pokémon'],
        )
        equivalent = collection_import_key(
            'swshp-SWSH057_de', 'Holo', 'de', 'NM', None,
            ['play pokemon', 'Poke-Ball'],
        )
        different = collection_import_key(
            'swshp-SWSH057_de', 'Holo', 'de', 'NM', None,
            ['Master Ball'],
        )

        self.assertEqual(accented, equivalent)
        self.assertNotEqual(accented, different)

    def test_duplicate_rows_are_merged_before_writing(self):
        planned = {}
        key = collection_import_key('swshp-SWSH057_de', 'Normal', 'de', 'NM', None)
        first = SimpleNamespace(quantity=2)
        second = SimpleNamespace(quantity=3)

        self.assertTrue(merge_collection_import_item(planned, key, first))
        self.assertFalse(merge_collection_import_item(planned, key, second))
        self.assertEqual(planned[key].quantity, 5)
        self.assertIs(planned[key], first)


if __name__ == '__main__':
    unittest.main()
