import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from api import backup as backup_api
from api.images import _get_or_fetch
from database import get_db
from models import ImageCache, Setting


class ServerImageCacheTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
        ImageCache.__table__.create(self.engine)
        Setting.__table__.create(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.db.add_all([
            ImageCache(image_key=key, data=b'cached-public-image', content_type='image/png')
            for key in ['card:fixture:large', 'set:fixture:logo', 'product:fixture']
        ])
        self.db.add(Setting(key='unrelated', value='preserved'))
        self.db.commit()
        self.user = SimpleNamespace(role='admin')
        self.app = FastAPI()
        self.app.include_router(backup_api.router, prefix='/api/backup')
        self.app.dependency_overrides[backup_api.get_current_user] = lambda: self.user
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.client = TestClient(self.app)
        # Never let the legacy implementation remove a real filesystem path in RED.
        self.filesystem_guard = patch.object(backup_api.os.path, 'exists', return_value=False)
        self.filesystem_guard.start()

    def tearDown(self):
        self.filesystem_guard.stop()
        self.client.close()
        self.db.close()
        self.engine.dispose()

    def clear(self):
        return self.client.post('/api/backup/clear-image-cache')

    def test_admin_deletes_database_cache_and_reports_count(self):
        response = self.clear()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.db.query(ImageCache).count(), 0)
        self.assertEqual(response.json()['deleted_count'], 3)
        self.assertEqual(self.db.query(Setting).one().value, 'preserved')

    def test_repeating_the_request_is_safe(self):
        self.clear()
        response = self.clear()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['deleted_count'], 0)

    def test_regular_user_cannot_delete_shared_cache(self):
        self.user.role = 'user'
        self.assertEqual(self.clear().status_code, 403)
        self.assertEqual(self.db.query(ImageCache).count(), 3)

    def test_unauthenticated_request_cannot_delete_cache(self):
        def unauthenticated():
            raise HTTPException(status_code=401, detail='Not authenticated')
        self.app.dependency_overrides[backup_api.get_current_user] = unauthenticated
        self.assertEqual(self.clear().status_code, 401)
        self.assertEqual(self.db.query(ImageCache).count(), 3)

    def test_commit_failure_rolls_back_and_does_not_report_success(self):
        with patch.object(self.db, 'commit', side_effect=SQLAlchemyError('simulated failure')):
            response = self.clear()
        self.assertEqual(response.status_code, 500)
        self.assertEqual(self.db.query(ImageCache).count(), 3)

    def test_next_image_request_repopulates_the_database_cache(self):
        self.assertEqual(self.clear().status_code, 200)
        upstream = SimpleNamespace(content=b'fresh-image', headers={'content-type': 'image/png'}, raise_for_status=lambda: None)
        with patch('api.images._client.get', return_value=upstream) as fetch:
            self.assertEqual(_get_or_fetch(self.db, 'card:fixture:large', 'https://assets.example.test/image.png'), (b'fresh-image', 'image/png'))
            self.assertEqual(_get_or_fetch(self.db, 'card:fixture:large', 'https://assets.example.test/image.png'), (b'fresh-image', 'image/png'))
        fetch.assert_called_once()
        self.assertEqual(self.db.query(ImageCache).count(), 1)


if __name__ == '__main__':
    unittest.main()
