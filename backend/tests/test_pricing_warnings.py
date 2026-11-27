"""Pricing warnings use synthetic catalogue data and never contact a provider."""
import copy
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from api.auth import get_current_user
from api.cards import router
from database import Base, get_db
from models import Card, Setting, User
from services.pricing_warnings import find_pricing_warnings


class PricingWarningsTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.user = User(username="pricing-reader", hashed_password="unused", role="trainer", is_active=True)
        self.db.add_all([self.user, Setting(key="tcgdex_sync_languages", value="en,de")])
        self.add_card("rare", "136", 918849, rarity="Special illustration rare")
        self.add_card("regular", "033", 918849, rarity="Double Rare")
        self.add_card("unaffected", "012", 123)
        self.db.commit()
        self.app = FastAPI()
        self.app.include_router(router, prefix="/api/cards")
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.db.close()
        self.engine.dispose()

    def add_card(self, id, number, product_id, **overrides):
        values = dict(id=id, tcg_card_id=id, name="Raikou ex", number=number, set_id="me06", lang="en", is_custom=False,
                      cardmarket_products=[{"product_id": product_id, "variant": "Holo"}], price_trend=0.13)
        values.update(overrides)
        card = Card(**values)
        self.db.add(card)
        return card

    def warnings(self, ids):
        return find_pricing_warnings(self.db, ids, self.user.id)

    def test_both_cards_warn_and_identify_the_other_printing(self):
        result = self.warnings(["rare", "regular", "unaffected"])
        warning = result["rare"][0]
        self.assertEqual(warning["code"], "shared_cardmarket_product")
        self.assertEqual(warning["severity"], "possible_mismatch")
        self.assertEqual(warning["product_id"], 918849)
        self.assertEqual(warning["other_cards"], [{"id": "regular", "name": "Raikou ex", "number": "033", "rarity": "Double Rare", "set_id": "me06", "lang": "en"}])
        self.assertEqual(result["regular"][0]["other_cards"][0]["id"], "rare")
        self.assertEqual(result["unaffected"], [])

    def test_scope_is_same_set_and_language_and_different_number(self):
        self.add_card("other-set", "999", 123, set_id="sv01")
        self.add_card("other-language", "999", 123, lang="de")
        self.add_card("same-number", "0012", 123)
        self.add_card("no-number", None, 123)
        self.add_card("custom", "999", 123, is_custom=True, custom_owner_id=self.user.id)
        self.db.commit()
        result = self.warnings(["unaffected", "custom", "missing"])
        self.assertEqual(result, {"unaffected": [], "custom": [], "missing": []})

    def test_multiple_products_and_repeated_finishes_are_deduplicated(self):
        rare = self.db.get(Card, "rare")
        rare.cardmarket_products = [{"product_id": 918849, "variant": "Holo"}, {"product_id": "918849", "variant": "Reverse Holo"}, {"product_id": 44}]
        self.add_card("third", "137", 44)
        self.db.commit()
        result = self.warnings(["rare"])["rare"]
        self.assertEqual([x["product_id"] for x in result], [44, 918849])
        self.assertEqual(len(result[1]["other_cards"]), 1)

    def test_invalid_products_do_not_create_collisions(self):
        invalid = [None, [], "123", {}, {"product_id": True}, {"product_id": -1}, {"product_id": 0}, {"product_id": 1.5}, {"product_id": "junk"}]
        for i, product in enumerate(invalid):
            self.add_card(f"invalid-{i}", str(200 + i), None, cardmarket_products=[product])
        self.db.commit()
        self.assertTrue(all(not value for value in self.warnings([f"invalid-{i}" for i in range(len(invalid))]).values()))

    def test_correcting_mapping_removes_warning_without_altering_prices_or_links(self):
        rare = self.db.get(Card, "rare")
        before = copy.deepcopy(rare.cardmarket_products)
        self.warnings(["rare"])
        self.assertEqual(rare.cardmarket_products, before)
        self.assertEqual(rare.price_trend, 0.13)
        self.assertFalse(self.db.dirty)
        rare.cardmarket_products = [{"product_id": 918980, "variant": "Holo"}]
        self.db.commit()
        self.assertEqual(self.warnings(["rare", "regular"]), {"rare": [], "regular": []})

    def test_hidden_language_is_not_disclosed(self):
        self.add_card("hidden-1", "1", 55, lang="fr")
        self.add_card("hidden-2", "2", 55, lang="fr")
        self.db.commit()
        self.assertEqual(self.warnings(["hidden-1"]), {"hidden-1": []})

    def test_query_count_does_not_grow_with_requested_card_count(self):
        for i in range(50):
            self.add_card(f"batch-{i}", str(300 + i), 918849)
        self.db.commit()
        self.db.refresh(self.user)
        statements = []
        def record(*args):
            statements.append(args[2])
        event.listen(self.engine, "before_cursor_execute", record)
        try:
            self.warnings(["rare"])
            single_count = len(statements)
            statements.clear()
            result = self.warnings([f"batch-{i}" for i in range(50)])
            self.assertEqual(len(statements), single_count)
            self.assertEqual(len(result["batch-0"][0]["other_cards"]), 51)
        finally:
            event.remove(self.engine, "before_cursor_execute", record)

    def test_api_is_read_only_and_documents_the_response(self):
        response = self.client.post("/api/cards/pricing-warnings", json={"card_ids": ["rare", "regular", "unaffected"]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["warnings"], self.warnings(["rare", "regular", "unaffected"]))
        self.assertIn("PricingWarningsResponse", self.app.openapi()["components"]["schemas"])
        self.assertFalse(self.db.dirty)

    def test_api_validates_batch_bounds_and_requires_authentication(self):
        for body in [{"card_ids": []}, {"card_ids": ["x"] * 501}, {"card_ids": [""]}, {"card_ids": ["x" * 201]}]:
            self.assertEqual(self.client.post("/api/cards/pricing-warnings", json=body).status_code, 422)
        self.app.dependency_overrides.pop(get_current_user)
        with patch("api.auth.multi_user_enabled", return_value=True):
            response = self.client.post("/api/cards/pricing-warnings", json={"card_ids": ["rare"]})
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
