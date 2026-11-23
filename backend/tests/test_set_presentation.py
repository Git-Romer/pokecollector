"""Set labels are exact-identity catalogue metadata, not guessed regional matches."""
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from api import sets
from api.auth import get_current_user
from database import Base, get_db
from models import Set, Setting, User, UserSetting


class SetPresentationTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.user = User(username='set-reader', hashed_password='synthetic', role='trainer', is_active=True)
        self.db.add(self.user)
        self.db.flush()
        self.db.add_all([
            Setting(key='tcgdex_sync_languages', value='en,de,ja'),
            UserSetting(user_id=self.user.id, key='language', value='en'),
            Set(id='shared_en', tcg_set_id='shared', name='English label', lang='en', release_date='2026-07-01'),
            Set(id='shared_de', tcg_set_id='shared', name='Deutscher Name', lang='de', release_date='2026-08-01'),
        ])
        self.db.commit()
        self.app = FastAPI()
        self.app.include_router(sets.router, prefix='/api/sets')
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(self.app)
        self.network = patch('api.sets.pokemon_api.get_all_sets', side_effect=AssertionError('No provider request expected'))
        self.network.start()

    def tearDown(self):
        self.network.stop()
        self.client.close()
        self.db.close()
        self.engine.dispose()

    def test_sets_api_keeps_source_name_date_and_language_and_adds_user_language_name(self):
        response = self.client.get('/api/sets/', params={'lang': 'de'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()), 1)
        item = response.json()[0]
        self.assertEqual(item['name'], 'Deutscher Name')
        self.assertEqual(item['lang'], 'de')
        self.assertEqual(item['release_date'], '2026-08-01')
        self.assertEqual(item.get('translated_name'), 'English label')
        self.assertEqual(item.get('translated_name_lang'), 'en')

    def test_explicit_name_language_overrides_only_the_label_metadata(self):
        item = self.client.get('/api/sets/?lang=en&name_lang=de').json()[0]
        self.assertEqual(item['name'], 'English label')
        self.assertEqual(item['lang'], 'en')
        self.assertEqual(item['release_date'], '2026-07-01')
        self.assertEqual(item['translated_name'], 'Deutscher Name')
        self.assertEqual(item['translated_name_lang'], 'de')

    def test_each_users_own_language_is_used_without_global_or_previous_request_leakage(self):
        other = User(username='other-reader', hashed_password='synthetic', role='trainer', is_active=True)
        self.db.add(other)
        self.db.flush()
        self.db.add(UserSetting(user_id=other.id, key='language', value='de'))
        self.db.commit()
        self.app.dependency_overrides[get_current_user] = lambda: other
        self.assertEqual(self.client.get('/api/sets/?lang=en').json()[0]['translated_name'], 'Deutscher Name')
        self.app.dependency_overrides[get_current_user] = lambda: self.user
        self.assertEqual(self.client.get('/api/sets/?lang=en').json()[0]['translated_name'], 'English label')

    def test_unavailable_names_do_not_guess_a_regional_equivalent(self):
        self.db.add(Set(id='exclusive_ja', tcg_set_id='exclusive', name='日本語のセット', lang='ja', abbreviation='SAME', release_date='2026-07-01'))
        self.db.commit()
        item = self.client.get('/api/sets/?lang=ja&name_lang=en').json()[0]
        self.assertEqual(item['name'], '日本語のセット')
        self.assertIsNone(item['translated_name'])
        self.assertIsNone(item['translated_name_lang'])

    def test_ui_only_language_has_no_invented_english_translation(self):
        item = self.client.get('/api/sets/?lang=de&name_lang=sv').json()[0]
        self.assertIsNone(item['translated_name'])
        self.assertIsNone(item['translated_name_lang'])

    def test_duplicate_canonical_id_is_ambiguous_and_is_not_guessed(self):
        self.db.add(Set(id='duplicate_en', tcg_set_id='shared', name='Other expansion', lang='en'))
        self.db.commit()
        item = self.client.get('/api/sets/?lang=de').json()[0]
        self.assertIsNone(item['translated_name'])

    def test_blank_translation_is_unavailable(self):
        self.db.get(Set, 'shared_en').name = ' '
        self.db.commit()
        self.assertIsNone(self.client.get('/api/sets/?lang=de').json()[0]['translated_name'])

    def test_labels_do_not_change_language_visibility_or_collection_counts(self):
        response = self.client.get('/api/sets/?lang=de&name_lang=en')
        self.assertEqual([item['id'] for item in response.json()], ['shared_de'])
        self.assertEqual(response.json()[0]['owned_count'], 0)
        self.assertEqual(self.db.query(Set).count(), 2)

    def test_sets_api_still_requires_authentication_when_multi_user_mode_is_enabled(self):
        self.app.dependency_overrides.pop(get_current_user)
        with patch('api.auth.multi_user_enabled', return_value=True):
            response = self.client.get('/api/sets/?lang=de&name_lang=en')
        self.assertEqual(response.status_code, 401, response.text)
