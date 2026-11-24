"""Regression coverage for edition-aware TCGplayer fallback valuation (#460)."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database import Base
from models import Card
from schemas import CardBase
from services.card_upsert import upsert_card

from services.pokemon_api import extract_prices
from services.card_values import effective_market_price


class TcgplayerEditionParsingTests(unittest.TestCase):
    def test_non_usd_tcgplayer_payload_is_not_relabelled_as_usd(self):
        prices = extract_prices({"pricing": {"tcgplayer": {
            "unit": "EUR", "unlimited": {"marketPrice": 4}, "1st-edition": {"marketPrice": 8},
        }}})
        self.assertIsNone(prices["price_tcg_normal_market"])
        self.assertIsNone(prices["price_tcg_first_edition_market"])

    def test_unlimited_and_first_edition_market_prices_remain_separate(self):
        prices = extract_prices({"pricing": {"cardmarket": None, "tcgplayer": {
            "unit": "USD",
            "unlimited": {"marketPrice": 4.05},
            "1st-edition": {"marketPrice": 8.27},
        }}})
        self.assertEqual(prices["price_tcg_normal_market"], 4.05)
        self.assertEqual(prices["price_tcg_first_edition_market"], 8.27)
        self.assertIsNone(prices["price_market"])
        self.assertIsNone(prices["price_trend"])


class TcgplayerValuationTests(unittest.TestCase):
    def test_german_tcgplayer_estimates_require_the_existing_price_fallback_permission(self):
        for lang in ('en', 'de', 'fr', 'ja', None):
            for allowed in (False, True):
                card = SimpleNamespace(lang=lang, price_tcg_normal_market=4, price_tcg_usd_to_eur=0.9,
                                       price_source_lang='en', tcgplayer_fallback_allowed=allowed)
                with self.subTest(lang=lang, allowed=allowed):
                    expected = 3.6 if lang == 'en' or (lang == 'de' and allowed) else 0
                    self.assertEqual(effective_market_price(card, 'Normal'), expected)
                    card.price_market = 2
                    self.assertEqual(effective_market_price(card, 'Normal'), 2)

    def test_invalid_or_missing_rates_never_treat_dollars_as_euros(self):
        for rate in (None, 0, -1, float("nan"), float("inf"), True, "invalid"):
            with self.subTest(rate=rate):
                self.assertEqual(effective_market_price(SimpleNamespace(
                    lang='en', price_tcg_normal_market=4, price_tcg_usd_to_eur=rate), "Normal"), 0)

    def test_variant_prices_are_not_borrowed_from_another_edition_or_finish(self):
        card = SimpleNamespace(lang='en', price_tcg_normal_market=4, price_tcg_usd_to_eur=0.9)
        for variant in ("First Edition", "Holo", "Reverse Holo", "Unknown"):
            with self.subTest(variant=variant):
                self.assertEqual(effective_market_price(card, variant), 0)

    def test_cardmarket_still_wins_for_every_supported_price_preference(self):
        for field in ("price_market", "price_trend", "price_avg1", "price_avg7", "price_avg30", "price_low"):
            with self.subTest(field=field):
                card = SimpleNamespace(**{field: 2}, price_tcg_normal_market=40, price_tcg_usd_to_eur=0.9)
                self.assertEqual(effective_market_price(card, "Normal", field), 2)

    def test_missing_cardmarket_uses_matching_usd_price_converted_to_eur(self):
        card = SimpleNamespace(
            lang='en',
            price_tcg_normal_market=4.0,
            price_tcg_first_edition_market=8.0,
            price_tcg_holo_market=12.0,
            price_tcg_reverse_market=16.0,
            price_tcg_usd_to_eur=0.9,
        )
        for variant, expected in [("Normal", 3.6), ("First Edition", 7.2), ("Holo", 10.8), ("Reverse Holo", 14.4)]:
            with self.subTest(variant=variant):
                self.assertAlmostEqual(effective_market_price(card, variant), expected)


class TcgplayerPersistenceTests(unittest.TestCase):
    def test_german_social_and_public_values_follow_the_same_setting(self):
        from models import User, CollectionItem, Setting
        from api.social import _load_user_stats
        from services.public_profile import _serialize_catalogue_card
        engine = create_engine('sqlite:///:memory:')
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        self.addCleanup(db.close)
        user = User(username='collector', hashed_password='unused')
        german = Card(id='test_de', name='German card', lang='de', price_tcg_normal_market=4,
                      price_tcg_usd_to_eur=0.9)
        setting = Setting(key='cross_language_price_fallback', value='true')
        db.add_all([user, german, setting])
        db.flush()
        db.add(CollectionItem(user_id=user.id, card_id=german.id, variant='Normal', quantity=2))
        db.commit()
        for enabled in ('true', 'false', 'true'):
            setting.value = enabled
            db.commit()
            expected = 3.6 if enabled == 'true' else 0
            stats = _load_user_stats(db, [user.id])[user.id]
            self.assertAlmostEqual(stats['total_value'], expected * 2)
            self.assertAlmostEqual(stats['most_valuable_card']['market_value'], expected)
            public = _serialize_catalogue_card(german, 2, True, variant='Normal')
            self.assertAlmostEqual(public['market_value'], expected)
            self.assertEqual(public['price_source'], 'tcgplayer' if enabled == 'true' else None)
            self.assertEqual(public['price_source_lang'], 'en' if enabled == 'true' else None)
        self.assertIsNone(german.price_market)

    def test_collection_totals_use_the_matching_edition_price_and_quantity(self):
        from models import User, CollectionItem
        from services.portfolio_valuation import calculate_portfolio_valuation
        engine = create_engine("sqlite:///:memory:")
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        self.addCleanup(db.close)
        user = User(username="collector", hashed_password="unused")
        card = Card(id="gym1-59_en", name="Growlithe", lang="en", price_tcg_normal_market=4,
                    price_tcg_first_edition_market=8, price_tcg_usd_to_eur=0.9)
        db.add_all([user, card])
        db.flush()
        items = [CollectionItem(user_id=user.id, card_id=card.id, variant="Normal", quantity=2),
                 CollectionItem(user_id=user.id, card_id=card.id, variant="First Edition", quantity=3)]
        db.add_all(items)
        db.commit()
        valuation = calculate_portfolio_valuation(db, user.id, collection_items=items)
        self.assertEqual(valuation.card_value, 28.8)
        self.assertEqual(valuation.total_value, 28.8)
        self.assertEqual(valuation.total_cards, 5)
        german = Card(id='gym1-59_de', name='German card', lang='de', price_source_lang='en',
                      price_tcg_normal_market=4, price_tcg_usd_to_eur=0.9)
        db.add(german)
        db.flush()
        items.append(CollectionItem(user_id=user.id, card_id=german.id, variant='Normal', quantity=4))
        db.add(items[-1])
        db.commit()
        from models import Setting
        for enabled in ('true', 'false', 'true'):
            setting = db.get(Setting, 'cross_language_price_fallback')
            if setting is None:
                db.add(Setting(key='cross_language_price_fallback', value=enabled))
            else:
                setting.value = enabled
            db.commit()
            expected = 28.8 + (4 * 3.6 if enabled == 'true' else 0)
            self.assertAlmostEqual(calculate_portfolio_valuation(db, user.id, collection_items=items).card_value, expected)
        with patch('services.exchange_rates.get_exchange_rate', return_value={'rate': 0.9}):
            upsert_card(db, {'id': card.id, 'price_market': 6})
            upsert_card(db, {'id': german.id, 'price_market': 2})
        db.commit()
        db.expire_all()
        self.assertEqual(effective_market_price(db.get(Card, card.id), 'First Edition'), 6)
        self.assertEqual(calculate_portfolio_valuation(db, user.id, collection_items=items).card_value, 6 * 5 + 2 * 4)

    def test_brief_updates_and_rate_outages_preserve_last_known_edition_value(self):
        from services.exchange_rates import ExchangeRateUnavailable
        from services.pokemon_api import parse_card_for_db
        engine = create_engine("sqlite:///:memory:")
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine, autoflush=False)()
        self.addCleanup(db.close)
        db.add(Card(id="gym1-59_en", name="Growlithe", price_tcg_first_edition_market=8, price_tcg_usd_to_eur=0.9))
        db.commit()
        upsert_card(db, parse_card_for_db({"id": "gym1-59", "name": "Native name"}))
        db.commit()
        with patch("services.exchange_rates.get_exchange_rate", side_effect=ExchangeRateUnavailable("unavailable")) as get_rate:
            upsert_card(db, {"id": "gym1-59_en", "price_tcg_first_edition_market": 10})
            upsert_card(db, {"id": "new_en", "name": "New", "price_tcg_normal_market": 4})
        db.commit()
        get_rate.assert_called_once()
        card = db.get(Card, "gym1-59_en")
        self.assertEqual(card.name, "Native name")
        self.assertEqual(effective_market_price(card, "First Edition"), 9)
        self.assertEqual(effective_market_price(db.get(Card, "new_en"), "Normal"), 0)

    def test_valuation_endpoint_returns_converted_amount_and_price_source(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from sqlalchemy.pool import StaticPool
        from api.auth import get_current_user
        from api.cards import router
        from database import get_db
        from models import User
        engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine)()
        self.addCleanup(db.close)
        user = User(username="collector", hashed_password="unused", role="trainer")
        db.add_all([user, Card(id="gym1-59_en", name="Growlithe", lang="en",
            price_tcg_normal_market=4, price_tcg_first_edition_market=8, price_tcg_usd_to_eur=0.9)])
        other = User(username="other", hashed_password="unused", role="trainer")
        db.add(other)
        db.add(Card(id='gym1-59_de', name='German card', lang='de', price_source_lang='en',
                    price_tcg_normal_market=4, price_tcg_usd_to_eur=0.9))
        db.flush()
        db.add(Card(id="private_en", name="Private", is_custom=True, custom_owner_id=other.id,
                    is_shared_template=False, price_market=99))
        db.commit()
        app = FastAPI()
        app.include_router(router, prefix="/api/cards")
        app.dependency_overrides[get_db] = lambda: db
        from api.settings import router as settings_router
        app.include_router(settings_router, prefix='/api/settings')
        app.dependency_overrides[get_current_user] = lambda: user
        user.role = 'admin'
        db.commit()
        with TestClient(app) as client, patch("services.exchange_rates.get_exchange_rate", return_value={"rate": 7.45}):
            response = client.get("/api/cards/gym1-59_en/valuation", params={"variant": "First Edition", "currency": "DKK"})
            self.assertEqual(client.get("/api/cards/private_en/valuation").status_code, 404)
            for enabled in ('true', 'false', 'true'):
                saved = client.put('/api/settings/', json={'cross_language_price_fallback': enabled})
                self.assertEqual(saved.status_code, 200, saved.text)
                self.assertEqual(client.get('/api/settings/').json()['cross_language_price_fallback'], enabled)
                german_quote = client.get('/api/cards/gym1-59_de/valuation').json()
                self.assertEqual(german_quote['amount'], 3.6 if enabled == 'true' else 0)
                self.assertEqual(german_quote['source'], 'tcgplayer' if enabled == 'true' else None)
                card_payload = client.get('/api/cards/gym1-59_de').json()
                self.assertEqual(card_payload['tcgplayer_fallback_allowed'], enabled == 'true')
                self.assertEqual(CardBase.model_validate(db.get(Card, 'gym1-59_de')).tcgplayer_fallback_allowed, enabled == 'true')
                # The language setting must not disable English-market cards.
                self.assertEqual(client.get('/api/cards/gym1-59_en/valuation').json()['amount'], 3.6)
            self.assertEqual(client.get("/api/cards/unknown_en/valuation").status_code, 404)
            self.assertEqual(client.get("/api/cards/gym1-59_en/valuation?variant=invalid").status_code, 422)
            self.assertEqual(client.get("/api/cards/gym1-59_en/valuation?currency=not-a-currency").status_code, 422)
            from services.exchange_rates import ExchangeRateUnavailable
            with patch("services.exchange_rates.get_exchange_rate", side_effect=ExchangeRateUnavailable("offline")):
                self.assertEqual(client.get("/api/cards/gym1-59_en/valuation?currency=DKK").status_code, 503)
        self.assertEqual(response.status_code, 200, response.text)
        quote = response.json()
        self.assertAlmostEqual(quote["amount"], 53.64)
        self.assertAlmostEqual(quote["amount_eur"], 7.2)
        self.assertEqual(quote["source"], "tcgplayer")
        self.assertEqual(quote["source_amount"], 8)
        self.assertEqual(quote["source_currency"], "USD")
        self.assertEqual(quote["currency"], "DKK")

    def test_edition_prices_and_conversion_survive_commit_and_api_serialization(self):
        engine = create_engine("sqlite:///:memory:")
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine, autoflush=False)()
        self.addCleanup(db.close)
        from services.pokemon_api import parse_card_for_db
        payload = parse_card_for_db({"id": "gym1-59", "name": "Blaine's Growlithe", "pricing": {
            "tcgplayer": {"unit": "USD", "unlimited": {"marketPrice": 4.05}, "1st-edition": {"marketPrice": 8.27}},
        }})
        with patch("services.exchange_rates.get_exchange_rate", return_value={"rate": 0.9}):
            upsert_card(db, payload)
        db.commit()
        db.expire_all()
        card = db.get(Card, "gym1-59_en")
        self.assertAlmostEqual(effective_market_price(card, "Normal"), 3.645)
        self.assertAlmostEqual(effective_market_price(card, "First Edition"), 7.443)
        result = CardBase.model_validate(card).model_dump()
        self.assertEqual(result["price_tcg_first_edition_market"], 8.27)
        self.assertEqual(result["price_tcg_usd_to_eur"], 0.9)
        self.assertIsNone(result["price_market"])


if __name__ == "__main__":
    unittest.main()
