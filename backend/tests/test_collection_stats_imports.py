import unittest


class CollectionStatsImportTests(unittest.TestCase):
    """get_collection_stats() calls these two helpers, so the module must import
    them. A merge once dropped the import while keeping both call sites, which
    made GET /collection/stats/summary raise NameError on every request."""

    def test_price_helpers_are_importable_from_collection_module(self):
        import api.collection as collection

        self.assertTrue(callable(getattr(collection, 'normalize_price_field', None)))
        self.assertTrue(callable(getattr(collection, 'effective_market_price', None)))


if __name__ == '__main__':
    unittest.main()
