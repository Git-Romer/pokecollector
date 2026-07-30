import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from api.auth import get_current_user
from api.collection import router as collection_router
from database import Base, _run_migrations, get_db
from models import Card, User


class CollectionMetadataContractTests(unittest.TestCase):
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
        for number in range(1, 8):
            self.db.add(
                Card(
                    id=f"sv1-{number}_en",
                    tcg_card_id=f"sv1-{number}",
                    name=f"Test Card {number}",
                    number=str(number),
                    lang="en",
                )
            )
        self.db.commit()
        self.db.refresh(self.user)

        app = FastAPI()
        app.include_router(collection_router, prefix="/api/collection")
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.db.close()
        self.engine.dispose()

    def post_card(self, number, **values):
        return self.client.post(
            "/api/collection/",
            json={"card_id": f"sv1-{number}_en", "quantity": 1, **values},
        )

    def test_collection_item_persists_care_and_provenance(self):
        response = self.post_card(
            1,
            acquisition_source="pulled",
            storage_type="PSA Slab",
            storage_detail="Slab Case A",
            grader="PSA",
            grade="10",
            certification_number="12345",
            notes="Pulled at home",
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["purchase_price"], 4.49)
        self.assertEqual(payload["acquisition_source"], "pulled")
        self.assertEqual(payload["storage_type"], "PSA Slab")
        self.assertEqual(payload["storage_detail"], "Slab Case A")
        self.assertEqual(payload["grader"], "PSA")
        self.assertEqual(payload["grade"], "10")
        self.assertEqual(payload["certification_number"], "12345")
        self.assertEqual(payload["notes"], "Pulled at home")

    def test_source_defaults_apply_only_when_purchase_price_is_omitted(self):
        omitted_pulled = self.post_card(2, acquisition_source="pulled")
        omitted_bulk = self.post_card(3, acquisition_source="bulk_before_tracking")
        explicit_pulled = self.post_card(
            4,
            acquisition_source="pulled",
            purchase_price=1.25,
        )
        explicit_bulk = self.post_card(
            5,
            acquisition_source="bulk_before_tracking",
            purchase_price=2.5,
        )
        explicit_null = self.post_card(
            6,
            acquisition_source="pulled",
            purchase_price=None,
        )

        for response in (
            omitted_pulled,
            omitted_bulk,
            explicit_pulled,
            explicit_bulk,
            explicit_null,
        ):
            self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(omitted_pulled.json()["purchase_price"], 4.49)
        self.assertEqual(omitted_bulk.json()["purchase_price"], 0.0)
        self.assertEqual(explicit_pulled.json()["purchase_price"], 1.25)
        self.assertEqual(explicit_bulk.json()["purchase_price"], 2.5)
        self.assertIsNone(explicit_null.json()["purchase_price"])

    def test_accepts_exactly_the_acquisition_sources_in_the_contract(self):
        for source in (
            "pulled",
            "bulk_before_tracking",
            "purchased",
            "trade",
            "gift",
            "other",
        ):
            with self.subTest(source=source):
                response = self.post_card(7, acquisition_source=source)
                self.assertEqual(response.status_code, 200, response.text)

        response = self.post_card(7, acquisition_source="unknown")

        self.assertEqual(response.status_code, 422, response.text)

    def test_startup_migrations_do_not_rewrite_existing_source_prices(self):
        class RecordingConnection:
            def __init__(self):
                self.statements = []

            def execute(self, statement):
                self.statements.append(str(statement))

            def commit(self):
                pass

            def rollback(self):
                pass

        connection = RecordingConnection()
        _run_migrations(connection)

        price_rewrites = [
            statement
            for statement in connection.statements
            if "update collection" in statement.lower()
            and "purchase_price" in statement.lower()
        ]
        self.assertEqual(price_rewrites, [])
