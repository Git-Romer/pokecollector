import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from api.collection import add_to_collection, update_collection_item
from database import Base
from models import Card, User
from schemas import CollectionItemCreate, CollectionItemUpdate


class CollectionLotMediaTests(unittest.TestCase):
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

    def test_collection_lot_creator_photo_and_social_links_persist(self):
        item = add_to_collection(
            CollectionItemCreate(
                card_id=self.card.id,
                primary_photo_url="https://example.com/card.jpg",
                instagram_url="https://instagram.com/john/card",
                pinterest_url="https://pinterest.com/pin/123",
                reels_url="https://instagram.com/reel/abc",
            ),
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(item.primary_photo_url, "https://example.com/card.jpg")
        self.assertEqual(item.instagram_url, "https://instagram.com/john/card")

        updated = update_collection_item(
            item.id,
            CollectionItemUpdate(reels_url="https://instagram.com/reel/updated"),
            current_user=self.user,
            db=self.db,
        )

        self.assertEqual(updated.reels_url, "https://instagram.com/reel/updated")
        self.assertEqual(updated.pinterest_url, "https://pinterest.com/pin/123")


if __name__ == "__main__":
    unittest.main()
