import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from api.collection import add_to_collection
from database import Base
from models import Card, User
from schemas import CollectionItemCreate


class CollectionMetadataTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.user = User(username="john", hashed_password="x", role="admin", is_active=True)
        self.card = Card(id="sv1-1_en", tcg_card_id="sv1-1", name="Test Card", number="1", lang="en")
        self.db.add_all([self.user, self.card])
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def test_default_condition_matches_simplified_labels(self):
        item = add_to_collection(
            CollectionItemCreate(card_id=self.card.id),
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(item.condition, "NM")

    def test_tag_slab_defaults_grader_and_keeps_certification(self):
        item = add_to_collection(
            CollectionItemCreate(
                card_id=self.card.id,
                protection_type="tag_slab",
                grade="Mint Gem",
                certification_number="TAG-777",
            ),
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(item.protection_type, "tag_slab")
        self.assertEqual(item.grader, "TAG")
        self.assertEqual(item.grade, "Mint Gem")
        self.assertEqual(item.certification_number, "TAG-777")

    def test_collection_intent_grail_and_history_persist(self):
        item = add_to_collection(
            CollectionItemCreate(
                card_id=self.card.id,
                collection_intent="pc",
                is_grail=True,
                card_history="Pulled from a birthday pack.",
            ),
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(item.collection_intent, "pc")
        self.assertTrue(item.is_grail)
        self.assertEqual(item.card_history, "Pulled from a birthday pack.")

    def test_pulled_card_persists_care_and_defaults_cost_basis(self):
        item = add_to_collection(
            CollectionItemCreate(
                card_id=self.card.id,
                acquisition_source="pulled",
                storage_type="PSA Slab",
                storage_detail="Slab Case A",
                grader="PSA",
                grade="10",
                certification_number="12345",
                notes="Pulled at home",
            ),
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(item.purchase_price, 4.49)
        self.assertEqual(item.acquisition_source, "pulled")
        self.assertEqual(item.storage_type, "PSA Slab")
        self.assertEqual(item.grader, "PSA")
        self.assertEqual(item.grade, "10")
        self.assertEqual(item.certification_number, "12345")
        self.assertEqual(item.notes, "Pulled at home")

    def test_bulk_before_tracking_has_no_per_card_cost_basis(self):
        item = add_to_collection(
            CollectionItemCreate(card_id=self.card.id, acquisition_source="bulk_before_tracking"),
            current_user=self.user,
            db=self.db,
        )
        self.assertIsNone(item.purchase_price)
