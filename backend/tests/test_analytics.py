import unittest

from services.analytics import sort_top_movers, summarize_collection_intents


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

    def test_portfolio_summary_scopes_vault_pc_and_top_main_collection(self):
        entries = [
            {"intent": "vault", "quantity": 1, "unit_cost": 100.0, "market_value": 150.0},
            {"intent": "pc", "quantity": 1, "unit_cost": 25.0, "market_value": 60.0},
            {"intent": "main_collection", "quantity": 1, "unit_cost": 1.0, "market_value": 100.0},
            {"intent": "main_collection", "quantity": 1, "unit_cost": 1.0, "market_value": 90.0},
            {"intent": "main_collection", "quantity": 1, "unit_cost": 1.0, "market_value": 10.0},
            {"intent": "main_collection", "quantity": 1, "unit_cost": 1.0, "market_value": 1.0},
            {"intent": "main_collection", "quantity": 1, "unit_cost": 1.0, "market_value": 0.5},
            {"intent": "main_collection", "quantity": 1, "unit_cost": 1.0, "market_value": 0.25},
            {"intent": "main_collection", "quantity": 1, "unit_cost": 1.0, "market_value": 0.2},
            {"intent": "main_collection", "quantity": 1, "unit_cost": 1.0, "market_value": 0.1},
            {"intent": "main_collection", "quantity": 1, "unit_cost": 1.0, "market_value": 0.05},
            {"intent": "main_collection", "quantity": 1, "unit_cost": 1.0, "market_value": 0.01},
        ]

        summary = summarize_collection_intents(entries)

        self.assertEqual(summary["vault"]["market_value"], 150.0)
        self.assertEqual(summary["pc"]["market_value"], 60.0)
        self.assertEqual(summary["main_collection"]["lots"], 1)
        self.assertEqual(summary["main_collection"]["market_value"], 100.0)

    def test_portfolio_summary_keeps_missing_basis_in_market_but_not_profit_loss(self):
        summary = summarize_collection_intents([
            {"intent": "vault", "quantity": 2, "unit_cost": None, "market_value": 80.0},
            {"intent": "vault", "quantity": 1, "unit_cost": 10.0, "market_value": 30.0},
            {"intent": "vault", "quantity": 1, "unit_cost": None, "market_value": 40.0, "sealed_product": True},
        ])

        vault = summary["vault"]
        self.assertEqual(vault["market_value"], 150.0)
        self.assertEqual(vault["cost_basis"], 10.0)
        self.assertEqual(vault["profit_loss"], 20.0)
        self.assertEqual(vault["cost_basis_needed"], {
            "lots": 2,
            "cards": 2,
            "sealed_products": 1,
            "market_value": 120.0,
        })

if __name__ == "__main__":
    unittest.main()
