"""Authenticated full-collection download manifests use the real visibility contract."""
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from api.auth import get_current_user
from api.collection import router
from database import Base, get_db
from models import Card, CollectionItem, Set, User


class CollectionOfflineTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.owner = User(username='offline-owner', hashed_password='x')
        self.other = User(username='offline-other', hashed_password='x')
        self.db.add_all([self.owner, self.other])
        self.db.flush()
        self.db.add(Set(id='base1_en', tcg_set_id='base1', name='Base', lang='en'))
        self.db.add_all([
            Card(id='base1-1_en', tcg_card_id='base1-1', name='Artwork', set_id='base1_en', number='1', lang='en', images_small='https://assets.tcgdex.net/en/base/base1/1/low.webp', images_large='https://assets.tcgdex.net/en/base/base1/1/high.webp'),
            Card(id='base1-2_en', tcg_card_id='base1-2', name='Missing artwork', set_id='base1_en', number='2', lang='en'),
            Card(id='base1-3_en', tcg_card_id='base1-3', name='Other owner', set_id='base1_en', number='3', lang='en'),
        ])
        self.db.flush()
        for card_id, owner, condition in [
            ('base1-1_en', self.owner, 'NM'), ('base1-1_en', self.owner, 'LP'),
            ('base1-2_en', self.owner, 'NM'), ('base1-3_en', self.other, 'NM'),
        ]:
            self.db.add(CollectionItem(user_id=owner.id, card_id=card_id, quantity=2, condition=condition, variant='Normal', lang='en'))
        self.db.commit()
        self.user = self.owner
        app = FastAPI()
        app.include_router(router, prefix='/api/collection')
        app.dependency_overrides[get_current_user] = lambda: self.user
        app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.db.close()
        self.engine.dispose()

    def test_private_custom_artwork_uses_an_explicit_placeholder(self):
        custom = Card(id='private-art_en', name='Private custom art', set_id='base1_en', lang='en', is_custom=True, custom_owner_id=self.owner.id, images_large='https://example.test/private.webp')
        self.db.add(custom)
        self.db.flush()
        self.db.add(CollectionItem(user_id=self.owner.id, card_id=custom.id, quantity=1))
        self.db.commit()
        result = self.client.get('/api/collection/offline-manifest').json()
        self.assertIn(custom.id, result['missing_artwork_card_ids'])
        self.assertFalse(any(custom.id in path for path in result['image_urls']))
        self.assertEqual(len(result['items']), 4)

    def test_artwork_revision_changes_without_exposing_upstream_urls(self):
        before = self.client.get('/api/collection/offline-manifest').json()['image_urls']
        original = next(url for url in before if url.startswith('/api/images/card/'))
        self.assertRegex(original, r'/large\?v=[a-f0-9]{16}$')
        self.db.get(Card, 'base1-1_en').custom_image_url = 'https://example.test/replacement.webp'
        self.db.commit()
        after = self.client.get('/api/collection/offline-manifest').json()['image_urls']
        self.assertNotEqual(before, after)
        self.assertNotIn('example.test', str(after))

    def test_thumbnail_only_artwork_is_not_reported_as_a_saved_original(self):
        card = self.db.get(Card, 'base1-1_en')
        card.images_large = None
        card.images_small = 'https://assets.tcgdex.net/en/base/base1/1/low.webp'
        self.db.commit()
        result = self.client.get('/api/collection/offline-manifest').json()
        self.assertEqual(result['image_urls'], ['/cardback.jpg'])
        self.assertIn('base1-1_en', result['missing_artwork_card_ids'])

    def test_manifest_contains_all_owned_rows_and_one_original_per_artwork(self):
        response = self.client.get('/api/collection/offline-manifest')
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result['user_id'], self.owner.id)
        self.assertEqual(result['version'], 1)
        self.assertEqual(len(result['items']), 3)
        self.assertEqual({url.split('?')[0] for url in result['image_urls']}, {'/api/images/card/base1-1_en/large', '/cardback.jpg'})
        self.assertEqual(result['missing_artwork_card_ids'], ['base1-2_en'])
        self.assertNotIn('base1-3_en', str(result))
        self.assertEqual(response.headers['cache-control'], 'private, no-store')
