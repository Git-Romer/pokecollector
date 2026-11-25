import unittest
from fastapi import FastAPI
from api.collection import router
from api.auth import get_current_user
from database import get_db
from models import Card, CollectionItem
from tests.test_collection_rule_text_search import CollectionRuleTextSearchTests as Fixture


class CollectionSpeciesViewTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture(methodName="runTest")
        self.fixture.setUp()
        self.db, self.user = self.fixture.db, self.fixture.user
        for card in self.db.query(Card).all():
            card.dex_ids = [25, 6] if card.id.startswith('attack-name') else None
            card.price_trend = 2
        self.db.commit()
        app = FastAPI()
        app.include_router(router, prefix='/api/collection')
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.app = app

    def tearDown(self):
        self.fixture.tearDown()

    def test_grouped_endpoint_counts_a_card_once_and_preserves_rows(self):
        # A synchronous in-memory SQLite session cannot cross the worker thread.
        # Invoke the matched endpoint directly after checking route registration.
        route = next((r for r in self.app.routes if r.path == '/api/collection/by-species'), None)
        assert route is not None, 'The collection grouping must be available through the API'
        result = route.endpoint(current_user=self.user, db=self.db, price_field='price_trend', rule_text=None, language='en')
        self.assertEqual(len(result['groups']), 1)
        self.assertEqual(result['groups'][0]['dex_id'], 25)
        self.assertEqual(result['groups'][0]['name'], 'Pikachu')
        self.assertEqual(result['groups'][0]['printing_count'], 1)
        self.assertEqual(result['groups'][0]['copies'], 3)
        self.assertEqual(result['groups'][0]['total_value'], 6)
        self.assertEqual(len(result['groups'][0]['items']), 2)
        self.assertEqual(len(result['other']['items']), 7)
        self.assertEqual(result['summary']['entries'], 9)
        self.assertEqual(result['summary']['copies'], 10)

    def _grouped(self, **kwargs):
        from api.collection import get_collection_by_species
        return get_collection_by_species(current_user=self.user, db=self.db, **kwargs)

    def test_rule_text_filter_is_preserved_and_other_users_stay_private(self):
        result = self._grouped(rule_text='thunder jab')
        self.assertEqual(result['summary']['entries'], 2)
        self.assertEqual(result['other']['items'], [])
        self.assertEqual(self._grouped(rule_text='private signal')['summary']['entries'], 0)

    def test_trainers_energy_custom_and_invalid_ids_remain_reachable(self):
        examples = [('attack-name_en', [True, 6.5, 1026, 'x'], None, False),
                    ('attack-effect_en', [25], 'Trainer', False),
                    ('ability-name_en', [25], 'Energy', False),
                    ('ability-effect_en', [25], 'Pokemon', True)]
        for card_id, ids, category, custom in examples:
            card = self.db.get(Card, card_id)
            card.dex_ids, card.supertype, card.is_custom = ids, category, custom
            if custom:
                card.custom_owner_id = self.user.id
        self.db.commit()
        from services.collection_species import collection_species
        raw = collection_species(self.db.query(CollectionItem).filter_by(user_id=self.user.id).all())
        self.assertEqual(raw['groups'], [])
        # Invalid stored metadata is outside CardResponse's integer-list contract.
        # Test classification above, then exercise API serialization with valid data.
        self.db.get(Card, 'attack-name_en').dex_ids = []
        self.db.commit()
        result = self._grouped()
        self.assertEqual(result['groups'], [])
        self.assertEqual(result['summary']['entries'], 9)
        self.assertEqual(len(result['other']['items']), 9)

    def test_price_preference_and_localised_pokedex_names(self):
        card = self.db.get(Card, 'attack-name_en')
        card.dex_ids = [6, 25]
        card.price_avg7 = 7
        self.db.commit()
        result = self._grouped(price_field='price_avg7', language='de')
        self.assertEqual(result['groups'][0]['name'], 'Glurak')
        self.assertEqual(result['groups'][0]['total_value'], 21)
        self.assertEqual(result['groups'][0]['items'][0]['card']['dex_ids'], [6, 25])
