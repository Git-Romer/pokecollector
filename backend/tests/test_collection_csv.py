import unittest
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from api.auth import get_current_user
from api.collection import router as collection_router
from database import Base, get_db
from models import Card, CollectionItem, Set, StorageLocation, User
from services.collection_csv import (
    collection_import_key,
    is_valid_collection_purchase_price,
    merge_collection_import_item,
    normalize_collection_variant,
)


class CollectionCsvImportReviewTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.user = User(username="john", hashed_password="x", role="admin", is_active=True)
        self.db.add(self.user)
        self.db.flush()
        self.db.add_all([
            Set(
                id="sv1_en",
                tcg_set_id="sv1",
                name="Test Set",
                abbreviation="SV1",
                lang="en",
            ),
            Card(
                id="sv1-1_en",
                tcg_card_id="sv1-1",
                name="Test Card",
                set_id="sv1",
                number="1",
                lang="en",
            ),
            StorageLocation(
                user_id=self.user.id,
                name="Binder 1",
                is_default=True,
            ),
        ])
        self.db.commit()
        self.db.refresh(self.user)

        app = FastAPI()
        app.include_router(collection_router, prefix="/api/collection")
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)
        self.csv = (
            "set_code,number,quantity,condition,variant,lang,purchase_price\n"
            "SV1,1,2,NM,Normal,en,\n"
        )

    def tearDown(self):
        self.client.close()
        self.db.close()
        self.engine.dispose()

    def _post_csv(self, commit=None):
        params = {} if commit is None else {"commit": str(commit).lower()}
        return self.client.post(
            "/api/collection/import-csv",
            params=params,
            files={"file": ("collection.csv", self.csv, "text/csv")},
        )

    def test_review_requires_explicit_confirmation_before_collection_changes(self):
        review = self._post_csv()

        self.assertEqual(review.status_code, 200, review.text)
        self.assertFalse(review.json()["committed"])
        self.assertEqual(review.json()["added"], 1)
        self.assertEqual(self.db.query(CollectionItem).count(), 0)

        committed = self._post_csv(commit=True)

        self.assertEqual(committed.status_code, 200, committed.text)
        self.assertTrue(committed.json()["committed"])
        self.assertEqual(self.db.query(CollectionItem).count(), 1)
        self.assertEqual(self.db.query(CollectionItem).one().quantity, 2)

        second_review = self._post_csv()

        self.assertFalse(second_review.json()["committed"])
        self.assertEqual(second_review.json()["updated"], 1)
        self.assertEqual(self.db.query(CollectionItem).one().quantity, 2)


class CollectionCsvTests(unittest.TestCase):
    def test_blank_variant_normalizes_to_normal(self):
        self.assertEqual(normalize_collection_variant(''), 'Normal')
        self.assertEqual(normalize_collection_variant(None), 'Normal')
        self.assertEqual(normalize_collection_variant(' Holo '), 'Holo')

    def test_purchase_price_must_be_finite_and_non_negative(self):
        self.assertTrue(is_valid_collection_purchase_price(0))
        self.assertTrue(is_valid_collection_purchase_price(12.5))
        self.assertFalse(is_valid_collection_purchase_price(-0.01))
        self.assertFalse(is_valid_collection_purchase_price(float('nan')))
        self.assertFalse(is_valid_collection_purchase_price(float('inf')))
        self.assertFalse(is_valid_collection_purchase_price(float('-inf')))

    def test_import_key_uses_exact_collection_attributes(self):
        key = collection_import_key('swshp-SWSH057_de', '', 'de', 'NM', None)
        self.assertEqual(key, ('swshp-SWSH057_de', 'Normal', 'de', 'NM', None))

    def test_different_collection_attributes_stay_separate(self):
        normal_key = collection_import_key('swshp-SWSH057_de', 'Normal', 'de', 'NM', None)
        holo_key = collection_import_key('swshp-SWSH057_de', 'Holo', 'de', 'NM', None)
        priced_key = collection_import_key('swshp-SWSH057_de', 'Normal', 'de', 'NM', 1.5)

        self.assertNotEqual(normal_key, holo_key)
        self.assertNotEqual(normal_key, priced_key)

    def test_duplicate_rows_are_merged_before_writing(self):
        planned = {}
        key = collection_import_key('swshp-SWSH057_de', 'Normal', 'de', 'NM', None)
        first = SimpleNamespace(quantity=2)
        second = SimpleNamespace(quantity=3)

        self.assertTrue(merge_collection_import_item(planned, key, first))
        self.assertFalse(merge_collection_import_item(planned, key, second))
        self.assertEqual(planned[key].quantity, 5)
        self.assertIs(planned[key], first)


if __name__ == '__main__':
    unittest.main()
