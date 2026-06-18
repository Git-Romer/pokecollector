import unittest

try:
    from services.sync_service import _parse_unique_sync_sets
    SYNC_DEPS_AVAILABLE = True
except ModuleNotFoundError:
    SYNC_DEPS_AVAILABLE = False


@unittest.skipUnless(SYNC_DEPS_AVAILABLE, "Backend sync dependencies are not installed")
class SyncSetDeduplicationTests(unittest.TestCase):
    def test_duplicate_sync_set_ids_are_collapsed_before_insert(self):
        parsed_sets, duplicate_count = _parse_unique_sync_sets([
            {
                "id": "XY5a",
                "_db_key": "XY5a_ja",
                "_lang": "ja",
                "name": "Original",
                "cardCount": {"total": 70, "official": 70},
            },
            {
                "id": "XY5a",
                "_db_key": "XY5a_ja",
                "_lang": "ja",
                "name": "Replacement",
                "cardCount": {"total": 71, "official": 71},
            },
            {
                "id": "base1",
                "_db_key": "base1_en",
                "_lang": "en",
                "name": "Base Set",
                "cardCount": {"total": 102, "official": 102},
            },
        ])

        self.assertEqual(duplicate_count, 1)
        self.assertEqual([row["id"] for row in parsed_sets], ["XY5a_ja", "base1_en"])
        self.assertEqual(parsed_sets[0]["name"], "Replacement")
        self.assertEqual(parsed_sets[0]["lang"], "ja")


if __name__ == "__main__":
    unittest.main()
