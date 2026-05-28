import unittest

from services.binder_csv import combine_binder_required_quantity


class BinderCsvTests(unittest.TestCase):
    def test_duplicate_required_quantities_are_summed(self):
        self.assertEqual(combine_binder_required_quantity(2, 3), 5)

    def test_combined_required_quantity_may_reach_99(self):
        self.assertEqual(combine_binder_required_quantity(98, 1), 99)

    def test_combined_required_quantity_rejects_values_over_99(self):
        with self.assertRaises(ValueError):
            combine_binder_required_quantity(98, 2)


if __name__ == "__main__":
    unittest.main()
