import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

import httpx

import services.analytics as analytics_service
from services.analytics import get_pokebeach_news, sort_top_movers, summarize_collection_intents


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


    def test_portfolio_summary_excludes_main_collection_sealed_product(self):
        summary = summarize_collection_intents([
            {"intent": "main_collection", "quantity": 2, "cost_basis": 10.0, "unit_cost": None, "market_value": 1000.0, "sealed_product": True},
            {"intent": "main_collection", "quantity": 1, "unit_cost": 1.0, "market_value": 50.0},
            {"intent": "vault", "quantity": 3, "cost_basis": 80.0, "unit_cost": None, "market_value": 120.0, "sealed_product": True},
            {"intent": "pc", "quantity": 2, "cost_basis": 30.0, "unit_cost": None, "market_value": 45.0, "sealed_product": True},
        ])

        self.assertEqual(summary["main_collection"]["sealed_products"], 0)
        self.assertEqual(summary["main_collection"]["market_value"], 50.0)
        self.assertEqual(summary["vault"]["sealed_products"], 3)
        self.assertEqual(summary["vault"]["cost_basis"], 80.0)
        self.assertEqual(summary["vault"]["profit_loss"], 40.0)
        self.assertEqual(summary["pc"]["sealed_products"], 2)
        self.assertEqual(summary["pc"]["cost_basis"], 30.0)
        self.assertEqual(summary["pc"]["profit_loss"], 15.0)

    def test_portfolio_summary_keeps_missing_basis_in_market_but_not_profit_loss(self):
        summary = summarize_collection_intents([
            {"intent": "vault", "quantity": 2, "unit_cost": None, "market_value": 80.0},
            {"intent": "vault", "quantity": 1, "unit_cost": 10.0, "market_value": 30.0},
            {"intent": "vault", "quantity": 4, "unit_cost": None, "market_value": 40.0, "sealed_product": True},
        ])

        vault = summary["vault"]
        self.assertEqual(vault["market_value"], 150.0)
        self.assertEqual(vault["cost_basis"], 10.0)
        self.assertEqual(vault["profit_loss"], 20.0)
        self.assertEqual(vault["cost_basis_needed"], {
            "lots": 2,
            "cards": 2,
            "sealed_products": 4,
            "market_value": 120.0,
        })

    def test_portfolio_summary_tolerates_unknown_market_value(self):
        summary = summarize_collection_intents([
            {"intent": "vault", "quantity": 1, "unit_cost": None, "market_value": None, "sealed_product": True},
            {"intent": "vault", "quantity": 1, "unit_cost": 25.0, "market_value": None},
            {"intent": "main_collection", "quantity": 1, "unit_cost": 1.0, "market_value": None},
        ])

        vault = summary["vault"]
        self.assertEqual(vault["market_value"], 0.0)
        self.assertEqual(vault["cost_basis"], 25.0)
        self.assertEqual(vault["profit_loss"], -25.0)
        self.assertEqual(vault["cost_basis_needed"], {
            "lots": 1,
            "cards": 0,
            "sealed_products": 1,
            "market_value": 0.0,
        })
        self.assertEqual(summary["main_collection"]["market_value"], 0.0)

    def test_pokebeach_news_parses_and_categorizes_feed(self):
        html = """
        <h2><a href="/2026/07/new-set-cards-revealed">New Set Cards Revealed</a></h2>
        <h2><a href="https://www.pokebeach.com/2026/07/worlds-deck-review">Worlds Deck Review</a></h2>
        <h2><a href="/2026/07/latias-ex-price-spikes">Latias ex Price Spikes</a></h2>
        """
        response = Mock(text=html)
        response.raise_for_status = Mock()
        with tempfile.TemporaryDirectory() as tmpdir, \
             patch.object(analytics_service, 'POKEBEACH_CACHE_PATH', Path(tmpdir) / 'pokebeach-news.json'), \
             patch.object(analytics_service.httpx, 'get', return_value=response):
            payload = get_pokebeach_news(limit=3)

        self.assertEqual(payload['source'], 'PokéBeach')
        self.assertFalse(payload['cached'])
        self.assertEqual([item['category'] for item in payload['items']], [
            'New Set Drops',
            'Meta & Deckbuilding',
            'Trending Cards',
        ])
        self.assertEqual(payload['items'][0]['url'], 'https://www.pokebeach.com/2026/07/new-set-cards-revealed')

    def test_pokebeach_news_falls_back_to_cache_on_fetch_error(self):
        cached = {
            'source': 'PokéBeach',
            'fetched_at': (datetime.now(timezone.utc) - timedelta(days=3)).isoformat(),
            'items': [{'title': 'Cached story', 'url': 'https://www.pokebeach.com/cached', 'category': 'Trending Cards', 'source': 'PokéBeach'}],
            'cached': False,
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            cache_path = Path(tmpdir) / 'pokebeach-news.json'
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps(cached), encoding='utf-8')
            with patch.object(analytics_service, 'POKEBEACH_CACHE_PATH', cache_path), \
                 patch.object(analytics_service.httpx, 'get', side_effect=httpx.ConnectError('offline')):
                payload = get_pokebeach_news(limit=3)

        self.assertTrue(payload['cached'])
        self.assertEqual(payload['items'][0]['title'], 'Cached story')

    def test_pokebeach_news_returns_empty_cached_payload_without_cache(self):
        with tempfile.TemporaryDirectory() as tmpdir, \
             patch.object(analytics_service, 'POKEBEACH_CACHE_PATH', Path(tmpdir) / 'missing.json'), \
             patch.object(analytics_service.httpx, 'get', side_effect=httpx.ConnectError('offline')):
            payload = get_pokebeach_news(limit=3)

        self.assertEqual(payload, {'source': 'PokéBeach', 'fetched_at': None, 'items': [], 'cached': True})

if __name__ == "__main__":
    unittest.main()
