import unittest

from services.analytics import sort_top_movers


class AnalyticsTests(unittest.TestCase):
    def test_top_movers_default_sort_uses_absolute_percentage_change(self):
        movers = [
            {"name": "Large value move", "change_pct": 20, "change_abs": 5.0},
            {"name": "Large percent move", "change_pct": -80, "change_abs": -1.0},
        ]

        sorted_movers = sort_top_movers(movers)

        self.assertEqual([m["name"] for m in sorted_movers], ["Large percent move", "Large value move"])

    def test_top_movers_absolute_sort_uses_absolute_value_change(self):
        movers = [
            {"name": "Large value move", "change_pct": 20, "change_abs": 5.0},
            {"name": "Large percent move", "change_pct": -80, "change_abs": -1.0},
        ]

        sorted_movers = sort_top_movers(movers, "absolute")

        self.assertEqual([m["name"] for m in sorted_movers], ["Large value move", "Large percent move"])


if __name__ == "__main__":
    unittest.main()
